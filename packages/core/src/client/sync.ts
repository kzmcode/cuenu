// 同期エンジン: push（送信キュー）→ pull（since カーソル）。
// 多重起動は1本化し、タブ/ウィンドウ間は Web Locks で排他する。

import type { ConnectionConfig, SyncController, SyncStatus } from '../repository';
import { createApiClient, isApiRequestError, type ApiClient, type FetchLike } from './api-client';
import { createImageProcessor, type ImageProcessor, prepareImage } from './images';
import type { CuenuRepository } from './repo';
import { applyPulledChanges, applyPushResults, toPushOp } from './sync-apply';
import { createCrossTabLock, nowIso } from './util';

export const PUSH_BATCH = 100;
export const PULL_LIMIT = 500;
/** setTimeout の上限（これを超えると即時発火する） */
const MAX_TIMER_MS = 2_147_483_647;

export interface SyncOptions {
  /** 定期同期間隔（既定 60 秒） */
  intervalMs?: number;
  /** ローカル変更後に同期するまでの待ち（既定 800ms） */
  debounceMs?: number;
  /** バックオフ初期値・上限 */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** テスト用: 画像縮小処理の差し替え */
  prepareImage?: typeof prepareImage;
}

export interface CuenuSyncStatus extends SyncStatus {
  /** 401: 再ログインが必要（ローカルデータは保持） */
  authRequired: boolean;
  /** バックオフ後の次回自動再試行時刻 */
  nextRetryAt: string | null;
}

export interface CuenuSyncController extends SyncController {
  status(): CuenuSyncStatus;
  /** 画像要約キューを処理（オンライン時・再表示時に呼ぶ。start() 中は自動） */
  processImages(): Promise<void>;
  /** 再ログイン後などにトークンを差し替える（認証切れ状態を解除して同期再開） */
  updateConnection(patch: Partial<ConnectionConfig>): void;
  readonly api: ApiClient;
}

export function createSyncController(
  repo: CuenuRepository,
  conn: ConnectionConfig,
  fetchImpl?: FetchLike,
  options: SyncOptions = {},
): CuenuSyncController {
  const internal = repo.internal;
  const intervalMs = options.intervalMs ?? 60_000;
  const debounceMs = options.debounceMs ?? 800;
  const backoffBase = options.backoffBaseMs ?? 2_000;
  const backoffMax = options.backoffMaxMs ?? 5 * 60_000;
  const lock = createCrossTabLock(`cuenu-sync:${repo.name}`);

  let connection = { ...conn };
  let api = createApiClient(connection.serverUrl, connection.token, fetchImpl);
  let online = typeof navigator !== 'undefined' && 'onLine' in navigator ? navigator.onLine : true;
  let syncing = false;
  let lastError: string | null = null;
  let authRequired = false;
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let nextRetryAt: string | null = null;
  let running: Promise<void> | null = null;
  let rerun = false;
  let started = false;
  /** stop() 後は再試行タイマーを予約しない */
  let stopped = false;
  const cleanups: (() => void)[] = [];

  let deviceReady = repo.ready().then(() => repo.setDeviceId(connection.deviceId));
  // 失敗は runOnce の await で扱う（未処理の reject にしない）
  deviceReady.catch(() => undefined);

  internal.setStatusProvider(() => ({
    configured: true,
    online,
    syncing,
    lastError,
    authRequired,
    nextRetryAt,
  }));

  const emit = () => internal.emitStatus();

  const images: ImageProcessor = createImageProcessor(repo, () => api, {
    canRun: () => online && !authRequired,
    prepare: options.prepareImage,
  });

  function scheduleRetry(delayMs?: number) {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    nextRetryAt = null;
    if (stopped) return;
    const exp = Math.min(backoffMax, backoffBase * 2 ** Math.max(0, failures - 1));
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, delayMs ?? Math.round(exp * (0.8 + Math.random() * 0.4))));
    nextRetryAt = new Date(Date.now() + delay).toISOString();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      nextRetryAt = null;
      void controller.syncNow();
    }, delay);
  }

  /** @returns 今回は再送を見送った op 数（サーバー側の一時的失敗） */
  async function pushAll(): Promise<number> {
    const attempted = new Set<string>();
    let deferredTotal = 0;
    for (let guard = 0; guard < 1000; guard++) {
      const batch = await internal.write(async (tx) => {
        const all = await tx.allOps();
        const b = all.filter((o) => !o.sending && !attempted.has(o.opId)).slice(0, PUSH_BATCH);
        for (const o of b) {
          o.sending = true;
          await tx.putOp(o);
        }
        return b;
      }, 'remote');
      if (!batch.length) return deferredTotal;
      for (const o of batch) attempted.add(o.opId);
      let res;
      try {
        res = await api.push({ deviceId: connection.deviceId, ops: batch.map(toPushOp) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await internal.write(async (tx) => {
          for (const sent of batch) {
            const o = (await tx.opsForMemo(sent.memoId)).find((x) => x.opId === sent.opId);
            if (!o) continue;
            o.sending = false;
            o.attempts++;
            o.lastError = msg;
            await tx.putOp(o);
          }
        }, 'remote');
        throw e;
      }
      const results = Array.isArray(res?.results) ? res.results : [];
      const { resolved, deferred } = await internal.write((tx) =>
        applyPushResults(tx, batch, results, internal.deviceId), 'remote',
      );
      deferredTotal += deferred;
      if (resolved === 0 && deferred === 0) throw new Error('push: サーバーが結果を返しませんでした');
    }
    return deferredTotal;
  }

  async function pullAll() {
    let since = (await internal.backend.getMeta<number>('syncCursor')) ?? 0;
    for (let guard = 0; guard < 100_000; guard++) {
      const res = await api.pull(since, PULL_LIMIT);
      if (!res || (res.changes != null && !Array.isArray(res.changes))) throw new Error('pull: サーバーの応答が不正です');
      const next = typeof res.nextSince === 'number' && Number.isFinite(res.nextSince) ? res.nextSince : since;
      await internal.write(async (tx) => {
        await applyPulledChanges(tx, res.changes ?? [], internal.deviceId);
        await tx.setMeta('syncCursor', next);
      }, 'remote');
      if (!res.hasMore || next === since) break;
      since = next;
    }
    await internal.write(async (tx) => {
      await tx.setMeta('initialImportDone', true);
      await tx.setMeta('lastSyncedAt', nowIso());
    });
  }

  async function runOnce() {
    if (authRequired || !online) return;
    syncing = true;
    emit();
    let deferred = 0;
    try {
      await deviceReady;
      await lock(async () => {
        // ロック保持中は他に送信中の者はいない → 前回中断の送信中フラグを解除
        await internal.write(async (tx) => {
          for (const o of await tx.allOps()) {
            if (o.sending) {
              o.sending = false;
              await tx.putOp(o);
            }
          }
        }, 'remote');
        deferred = await pushAll();
        await pullAll();
      });
      await internal.reloadMeta();
      if (deferred > 0) {
        failures++;
        lastError = 'サーバーが混雑しているため一部の送信を後で再試行します';
        scheduleRetry();
      } else {
        failures = 0;
        lastError = null;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        nextRetryAt = null;
      }
    } catch (e) {
      if (isApiRequestError(e) && e.isAuthError) {
        authRequired = true;
        lastError = '認証の有効期限が切れました。再ログインしてください（端末内のデータは保持されています）';
      } else if (isApiRequestError(e) && e.code === 'incompatible_client') {
        lastError = 'アプリの更新が必要です';
      } else {
        failures++;
        lastError =
          isApiRequestError(e) && e.code === 'network' ? 'サーバーに接続できません' : e instanceof Error ? e.message : String(e);
        scheduleRetry(isApiRequestError(e) && e.retryAfterSec != null ? e.retryAfterSec * 1000 : undefined);
      }
    } finally {
      syncing = false;
      emit();
    }
    if (started && !authRequired && lastError === null) void images.run();
  }

  const on = (target: EventTarget | undefined, type: string, fn: () => void) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };

  const controller: CuenuSyncController = {
    get api() {
      return api;
    },
    status: () => repo.syncStatus() as CuenuSyncStatus,
    syncNow() {
      if (running) {
        rerun = true;
        return running;
      }
      running = (async () => {
        try {
          do {
            rerun = false;
            await runOnce();
          } while (rerun && !authRequired && online);
        } finally {
          running = null;
        }
      })();
      return running;
    },
    processImages: () => images.run(),
    updateConnection(patch) {
      connection = { ...connection, ...patch };
      api = createApiClient(connection.serverUrl, connection.token, fetchImpl);
      const newDeviceId = patch.deviceId;
      if (newDeviceId) {
        // 次の同期は deviceId の更新完了を待つ
        deviceReady = deviceReady.catch(() => undefined).then(() => repo.setDeviceId(newDeviceId));
        deviceReady.catch(() => undefined);
      }
      authRequired = false;
      lastError = null;
      failures = 0;
      emit();
      void controller.syncNow();
    },
    start() {
      if (started) return;
      started = true;
      stopped = false;
      const win = typeof window !== 'undefined' ? window : undefined;
      const doc = typeof document !== 'undefined' ? document : undefined;
      on(win, 'online', () => {
        online = true;
        failures = 0;
        emit();
        void controller.syncNow();
        void images.run();
      });
      on(win, 'offline', () => {
        online = false;
        emit();
      });
      on(doc, 'visibilitychange', () => {
        if (doc?.visibilityState === 'visible') {
          void controller.syncNow();
          void images.run();
        }
      });
      const timer = setInterval(() => void controller.syncNow(), intervalMs);
      cleanups.push(() => clearInterval(timer));
      let debounce: ReturnType<typeof setTimeout> | null = null;
      const unsub = repo.subscribe((e) => {
        if (e.type !== 'memo-changed' || e.origin !== 'local') return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void controller.syncNow(), debounceMs);
      });
      cleanups.push(unsub, () => debounce && clearTimeout(debounce));
      internal.onImageQueued = () => void images.run();
      cleanups.push(() => (internal.onImageQueued = null));
      void controller.syncNow();
      void images.run();
    },
    stop() {
      started = false;
      stopped = true;
      for (const c of cleanups.splice(0)) c();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      nextRetryAt = null;
      emit();
    },
  };
  return controller;
}
