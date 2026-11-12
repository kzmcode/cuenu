// PWA のプラットフォーム実装（リポジトリ・同期・認証・サーバー機能・通知）を束ねる。
import type { MemoRepository } from '@cuenu/core';
import { createSyncController, type CuenuRepository, type CuenuSyncController } from '@cuenu/core/client';
import type { AuthAdapter, CuenuPlatform, ServerAdapter } from '@cuenu/ui';
import { createPushAdapter } from './push';
import { loadSession, loginWithPassword, logoutRemote, saveSession, type Session } from './session';

const DEVICE_KEY = 'cuenu.lastDeviceId';

export interface WebHost {
  getPlatform(): CuenuPlatform;
  subscribe(l: () => void): () => void;
}

export function createWebHost(repo: CuenuRepository | MemoRepository, deviceId: string | null, persistent: boolean): WebHost {
  let session: Session | null = persistent ? loadSession() : null;
  let sync: CuenuSyncController | null = null;
  let authRequired = false;
  const listeners = new Set<() => void>();
  const isCuenuRepo = (r: unknown): r is CuenuRepository => typeof (r as CuenuRepository).internal === 'object';

  const startSync = () => {
    sync?.stop();
    sync = null;
    authRequired = false;
    if (!session || !isCuenuRepo(repo)) return;
    sync = createSyncController(repo, { serverUrl: '', token: session.token, deviceId: session.deviceId });
    sync.start();
  };

  const api = () => sync?.api ?? null;
  const requireApi = () => {
    const a = api();
    if (!a) throw new Error('ログインが必要です');
    return a;
  };

  const auth: AuthAdapter = {
    isLoggedIn: () => !!session && !authRequired,
    async login({ password }) {
      let prev: string | undefined;
      try {
        prev = session?.deviceId ?? localStorage.getItem(DEVICE_KEY) ?? undefined;
      } catch {
        prev = session?.deviceId;
      }
      const s = await loginWithPassword(password, prev);
      if (isCuenuRepo(repo)) await repo.setDeviceId(s.deviceId);
      session = s;
      saveSession(s);
      try {
        localStorage.setItem(DEVICE_KEY, s.deviceId);
      } catch {
        /* noop */
      }
      startSync();
      emit();
    },
    async logout() {
      const s = session;
      sync?.stop();
      sync = null;
      session = null;
      saveSession(null);
      emit();
      // サーバーはログアウトで端末の購読を消すため、端末側の購読も外す（再ログイン後に「有効」と誤表示しない）
      void notifications.disable().catch(() => {});
      if (s) await logoutRemote(s).catch(() => {}); // 端末内のメモ・未送信は消さない
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };

  const server: ServerAdapter = {
    semanticSearch: (query, limit) => requireApi().semanticSearch({ query, limit }),
    aiStatus: () => requireApi().aiStatus(),
    getSettings: () => requireApi().getSettings(),
    putSettings: (patch) => requireApi().putSettings(patch),
  };

  const notifications = createPushAdapter(api, () => session?.deviceId ?? null);

  let platform: CuenuPlatform;
  const build = () => {
    platform = { repo, sync, auth, server, notifications, deviceId: session?.deviceId ?? deviceId, kind: 'web' };
  };
  const emit = () => {
    build();
    for (const l of listeners) l();
  };

  repo.subscribe((e) => {
    if (e.type !== 'sync-status' || !sync) return;
    const ar = sync.status().authRequired;
    if (ar !== authRequired) {
      authRequired = ar;
      emit();
    }
  });

  startSync();
  build();
  return { getPlatform: () => platform, subscribe: auth.subscribe! };
}
