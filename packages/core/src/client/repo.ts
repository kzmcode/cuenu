// MemoRepository の共通実装（保存方式は Backend で差し替え）。
// 読み取りは全件をメモリにキャッシュして高速化し、書き込みは Backend のトランザクションで行う。

import type { ExportBundle } from '../api';
import type {
  CreateMemoInput,
  MemoRepository,
  Page,
  RepoEvent,
  SearchHit,
  SearchQuery,
  SyncStatus,
} from '../repository';
import type { Draft, LocalMemo, Memo, MemoWithMeta } from '../types';
import type { Backend, StoredMemo, Tx } from './backend';
import { adoptServer, enqueueDelete, enqueueUpsert } from './ops';
import { createSearchIndex, type SearchIndex } from './search';
import { RepoError, nowIso, uuid } from './util';

export interface RepoOptions {
  /** 端末ID。未指定なら meta に保存済みのもの、無ければ生成 */
  deviceId?: string;
  /** 初回取り込み不要（サーバー未接続）なら true。既定 true */
  localOnly?: boolean;
  /** BroadcastChannel 名。null で無効。既定は backend.name */
  channelName?: string | null;
}

/** 同期エンジン・画像キューが使う内部 API（UI からは使わない） */
export interface RepoInternal {
  readonly backend: Backend;
  readonly deviceId: string;
  /** origin は memo-changed イベントの origin（同期由来は 'remote'） */
  write<T>(fn: (tx: Tx) => Promise<T>, origin?: 'local' | 'remote'): Promise<T>;
  cached(id: string): StoredMemo | undefined;
  /** 同期状態の提供者を登録（SyncController） */
  setStatusProvider(p: (() => Partial<SyncStatus>) | null): void;
  emitStatus(): void;
  /** meta を書いた後に呼ぶ（キャッシュ値と他タブへ反映） */
  reloadMeta(broadcast?: boolean): Promise<void>;
  /** 画像要約の再開要求フック */
  onImageQueued: (() => void) | null;
}

export interface CuenuRepository extends MemoRepository {
  readonly name: string;
  ready(): Promise<void>;
  deviceId(): Promise<string>;
  /** ログインでサーバーが返した deviceId を設定（自端末の待機中画像の originDeviceId も更新） */
  setDeviceId(id: string): Promise<void>;
  /** SyncController 未接続でも使える現在の同期状態 */
  syncStatus(): SyncStatus;
  close(): void;
  readonly internal: RepoInternal;
}

const strip = (m: StoredMemo): LocalMemo => {
  const { serverVersion: _sv, ...rest } = m;
  return structuredClone(rest);
};

const assertBody = (body: string) => {
  if (typeof body !== 'string' || body.trim() === '') throw new RepoError('empty_body', '本文が空です');
};

export function createRepository(backend: Backend, options: RepoOptions = {}): CuenuRepository {
  const cache = new Map<string, StoredMemo>();
  const children = new Map<string, Set<string>>();
  const listeners = new Set<(e: RepoEvent) => void>();
  let index: SearchIndex;
  let deviceId = '';
  let pendingOps = 0;
  let initialImportDone = options.localOnly ?? true;
  let lastSyncedAt: string | null = null;
  let statusProvider: (() => Partial<SyncStatus>) | null = null;
  let closed = false;
  let lastCreatedMs = 0;
  /** 同一ミリ秒の連続投稿でも順序が入れ替わらないよう単調増加させる */
  const createdNow = () => {
    let t = Date.now();
    if (t <= lastCreatedMs) t = lastCreatedMs + 1;
    lastCreatedMs = t;
    return new Date(t).toISOString();
  };
  const channelName = options.channelName === undefined ? backend.name : options.channelName;
  const channel =
    channelName && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(channelName) : null;

  const emit = (e: RepoEvent) => {
    for (const l of [...listeners]) {
      try {
        l(e);
      } catch (err) {
        console.error(err);
      }
    }
  };

  const putCache = (m: StoredMemo) => {
    const old = cache.get(m.id);
    if (old && old.parentId && old.parentId !== m.parentId) children.get(old.parentId)?.delete(m.id);
    cache.set(m.id, m);
    if (m.parentId) {
      let set = children.get(m.parentId);
      if (!set) children.set(m.parentId, (set = new Set()));
      set.add(m.id);
    }
    index.put(m, old);
  };

  const isVisible = (m: StoredMemo): boolean => {
    if (m.deletedAt) return false;
    if (m.parentId) {
      const p = cache.get(m.parentId);
      if (p?.deletedAt) return false;
    }
    return true;
  };

  const liveReplies = (parentId: string): StoredMemo[] => {
    const ids = children.get(parentId);
    if (!ids) return [];
    const out: StoredMemo[] = [];
    for (const id of ids) {
      const m = cache.get(id);
      if (m && !m.deletedAt) out.push(m);
    }
    return out;
  };

  const withMeta = (m: StoredMemo): MemoWithMeta => ({
    ...strip(m),
    replyCount: m.parentId ? 0 : liveReplies(m.id).length,
  });

  const computeStatus = (): SyncStatus => {
    let conflicts = 0;
    for (const m of cache.values()) if (m.conflict && !m.deletedAt) conflicts++;
    const base: SyncStatus = {
      configured: false,
      online: typeof navigator !== 'undefined' && 'onLine' in navigator ? navigator.onLine : true,
      syncing: false,
      pendingOps,
      lastSyncedAt,
      lastError: null,
      initialImportDone,
      conflicts,
    };
    return { ...base, ...(statusProvider?.() ?? {}), pendingOps, conflicts, initialImportDone, lastSyncedAt };
  };

  const refreshStatus = async () => {
    if (closed) return;
    pendingOps = await backend.countOps();
    emit({ type: 'sync-status', status: computeStatus() });
  };

  const loadMeta = async () => {
    initialImportDone = (await backend.getMeta<boolean>('initialImportDone')) ?? options.localOnly ?? true;
    lastSyncedAt = (await backend.getMeta<string>('lastSyncedAt')) ?? null;
  };

  const readyPromise = (async () => {
    index = createSearchIndex();
    const all = await backend.loadAllMemos();
    for (const m of all) putCache(m);
    const stored = await backend.getMeta<string>('deviceId');
    deviceId = options.deviceId ?? stored ?? uuid();
    if (deviceId !== stored) await backend.transact((tx) => tx.setMeta('deviceId', deviceId));
    await loadMeta();
    pendingOps = await backend.countOps();
  })();

  const write = async <T>(fn: (tx: Tx) => Promise<T>, origin: 'local' | 'remote' = 'local'): Promise<T> => {
    await readyPromise;
    if (closed) throw new RepoError('closed');
    const touched = new Map<string, StoredMemo>();
    const result = await backend.transact((tx) => {
      touched.clear();
      const wtx: Tx = {
        ...tx,
        putMemo: (m) => {
          touched.set(m.id, structuredClone(m));
          return tx.putMemo(m);
        },
      };
      return fn(wtx);
    });
    if (touched.size) {
      for (const m of touched.values()) putCache(m);
      const ids = [...touched.keys()];
      emit({ type: 'memo-changed', ids, origin });
      channel?.postMessage({ type: 'memos', ids });
    }
    await refreshStatus();
    return result;
  };

  if (channel) {
    channel.onmessage = async (ev: MessageEvent) => {
      const msg = ev.data as { type: string; ids?: string[] };
      await readyPromise;
      if (closed) return;
      if (msg.type === 'memos' && msg.ids) {
        const fresh = await backend.getMemos(msg.ids);
        const ids: string[] = [];
        for (const m of fresh) {
          if (m) {
            putCache(m);
            ids.push(m.id);
          }
        }
        if (ids.length) emit({ type: 'memo-changed', ids, origin: 'remote' });
        await refreshStatus();
      } else if (msg.type === 'meta') {
        await loadMeta();
        await refreshStatus();
      }
    };
  }

  const mustGet = async (tx: Tx, id: string) => {
    const m = await tx.getMemo(id);
    if (!m) throw new RepoError('not_found');
    return m;
  };

  const resolveInTx = async (
    tx: Tx,
    m: StoredMemo,
    resolution: 'keep-local' | 'keep-server' | { body: string },
  ): Promise<StoredMemo> => {
    const c = m.conflict;
    if (!c) throw new RepoError('no_conflict');
    const resolved = adoptServer(m, c.server, deviceId);
    // 競合中に積まれた image のみの op があれば温存されるよう version 等は enqueueUpsert に任せる
    const body =
      c.server.deletedAt || resolution === 'keep-server'
        ? null
        : resolution === 'keep-local'
          ? c.localBody
          : resolution.body;
    if (body !== null) assertBody(body);
    if (body === null || body === c.server.body) {
      // 本文はサーバー版のまま。image 等の未送信 op が残っていれば pending
      if ((await tx.opsForMemo(m.id)).length) resolved.syncState = 'pending';
      await tx.putMemo(resolved);
      return resolved;
    }
    const t = nowIso();
    resolved.body = body;
    resolved.editedAt = t;
    resolved.updatedAt = t;
    return enqueueUpsert(tx, resolved, true);
  };

  const internal: RepoInternal = {
    backend,
    get deviceId() {
      return deviceId;
    },
    write,
    cached: (id) => cache.get(id),
    setStatusProvider(p) {
      statusProvider = p;
    },
    emitStatus() {
      if (!closed) emit({ type: 'sync-status', status: computeStatus() });
    },
    async reloadMeta(broadcast = true) {
      await loadMeta();
      if (broadcast) channel?.postMessage({ type: 'meta' });
      await refreshStatus();
    },
    onImageQueued: null,
  };

  const repo: CuenuRepository = {
    name: backend.name,
    internal,
    ready: () => readyPromise,
    async deviceId() {
      await readyPromise;
      return deviceId;
    },
    async setDeviceId(id) {
      await readyPromise;
      if (id === deviceId) return;
      const old = deviceId;
      const imageIds = await backend.listImageIds();
      await write(async (tx) => {
        await tx.setMeta('deviceId', id);
        for (const mid of imageIds) {
          const m = await tx.getMemo(mid);
          if (m?.image && m.image.originDeviceId === old && !m.deletedAt) {
            m.image = { ...m.image, originDeviceId: id };
            await enqueueUpsert(tx, m, false);
          }
        }
      });
      deviceId = id;
    },
    syncStatus: computeStatus,
    close() {
      closed = true;
      channel?.close();
      listeners.clear();
      backend.close();
    },

    async create(input: CreateMemoInput) {
      const hasImage = !!input.image;
      if (!hasImage) assertBody(input.body);
      const data = input.image ? await input.image.arrayBuffer() : null;
      await readyPromise;
      const m = await write(async (tx) => {
        let parentId = input.parentId ?? null;
        if (parentId) {
          const parent = await mustGet(tx, parentId);
          if (parent.deletedAt) throw new RepoError('deleted', '返信先が削除されています');
          parentId = parent.parentId ?? parent.id; // 返信への返信はスレッド直下にまとめる
        }
        const t = createdNow();
        const memo: StoredMemo = {
          id: uuid(),
          parentId,
          author: 'user',
          body: input.body ?? '',
          createdAt: t,
          updatedAt: t,
          editedAt: null,
          version: 1,
          deletedAt: null,
          tags: [],
          emoji: null,
          tagsVersion: null,
          ai: null,
          image: hasImage
            ? {
                status: 'waiting',
                originDeviceId: deviceId,
                summary: null,
                applied: false,
                error: null,
                baseVersion: 1,
              }
            : null,
          serverSeq: null,
          syncState: 'pending',
          syncError: null,
          conflict: null,
          serverVersion: 0,
        };
        await enqueueUpsert(tx, memo, true);
        if (data && input.image) {
          await tx.putImage({
            memoId: memo.id,
            mimeType: input.image.type || 'application/octet-stream',
            data,
            createdAt: t,
          });
        }
        return memo;
      });
      if (hasImage) internal.onImageQueued?.();
      return strip(m);
    },

    async updateBody(id, body) {
      assertBody(body);
      const m = await write(async (tx) => {
        const m = await mustGet(tx, id);
        if (m.deletedAt) throw new RepoError('deleted');
        if (m.author === 'ai') throw new RepoError('readonly', 'AI投稿の本文は編集できません');
        if (m.conflict) return resolveInTx(tx, m, { body });
        if (m.body === body) return m;
        const t = nowIso();
        m.body = body;
        m.editedAt = t;
        m.updatedAt = t;
        return enqueueUpsert(tx, m, true);
      });
      return strip(m);
    },

    async setLiked(id, liked) {
      const m = await write(async (tx) => {
        const m = await mustGet(tx, id);
        if (m.deletedAt) throw new RepoError('deleted');
        if (m.author !== 'ai') throw new RepoError('readonly', 'いいねは AI の投稿にだけ付けられます');
        if (!!m.liked === liked) return m;
        m.liked = liked;
        m.updatedAt = nowIso();
        return enqueueUpsert(tx, m, false);
      });
      return strip(m);
    },

    async remove(id) {
      await write(async (tx) => {
        const m = await mustGet(tx, id);
        if (m.deletedAt) return;
        const t = nowIso();
        m.deletedAt = t;
        m.updatedAt = t;
        m.syncState = 'pending';
        await tx.putMemo(m);
        await enqueueDelete(tx, m);
        if (!m.parentId) {
          // サーバーも親削除で返信を tombstone 化するので op は親の1件だけ
          for (const r of await tx.childrenOf(id)) {
            if (r.deletedAt) continue;
            r.deletedAt = t;
            r.updatedAt = t;
            await tx.putMemo(r);
          }
        }
      });
    },

    async undoRemove(id) {
      await write(async (tx) => {
        const m = await mustGet(tx, id);
        if (!m.deletedAt) return;
        const ops = await tx.opsForMemo(id);
        const del = ops.find((o) => o.kind === 'delete' && !o.sending);
        if (!del) throw new RepoError('cannot_undo', '同期済みの削除は取り消せません');
        await tx.deleteOp(del.opId);
        const ts = m.deletedAt;
        m.deletedAt = null;
        m.updatedAt = nowIso();
        m.syncState = ops.length > 1 ? 'pending' : m.conflict ? 'conflict' : 'synced';
        await tx.putMemo(m);
        if (!m.parentId) {
          for (const r of await tx.childrenOf(id)) {
            if (r.deletedAt !== ts) continue;
            r.deletedAt = null;
            await tx.putMemo(r);
          }
        }
      });
    },

    async get(id) {
      await readyPromise;
      const m = cache.get(id);
      return m && isVisible(m) ? withMeta(m) : null;
    },

    async timeline(cursor, limit = 30) {
      await readyPromise;
      const { items, nextCursor } = index.page(
        (m) => !m.parentId && !m.deletedAt,
        cursor ?? null,
        limit,
      );
      return { items: items.map(withMeta), nextCursor };
    },

    async replies(parentId) {
      await readyPromise;
      const p = cache.get(parentId);
      if (p?.deletedAt) return [];
      return liveReplies(parentId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
        .map(withMeta);
    },

    async search(q: SearchQuery): Promise<Page<SearchHit>> {
      await readyPromise;
      const pred = index.matcher(q, isVisible);
      const { items, nextCursor } = index.page(pred, q.cursor ?? null, q.limit ?? 30);
      return {
        items: items.map((m) => ({ memo: withMeta(m), threadId: m.parentId ?? m.id })),
        nextCursor,
      };
    },

    async tags() {
      await readyPromise;
      const counts = new Map<string, number>();
      for (const m of cache.values()) {
        if (!isVisible(m)) continue;
        for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      return [...counts]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    },

    async resolveConflict(id, resolution) {
      const m = await write(async (tx) => resolveInTx(tx, await mustGet(tx, id), resolution));
      return strip(m);
    },

    async applyImageSummary(id) {
      const m = await write(async (tx) => {
        const m = await mustGet(tx, id);
        if (m.deletedAt) throw new RepoError('deleted');
        const img = m.image;
        if (!img?.summary || img.applied) throw new RepoError('no_summary', '反映できる要約がありません');
        const t = nowIso();
        m.body = appendSummary(m.body, img.summary);
        m.editedAt = t;
        m.updatedAt = t;
        m.image = { ...img, applied: true };
        if (m.conflict) return resolveInTx(tx, m, { body: appendSummary(m.conflict.localBody, img.summary) });
        return enqueueUpsert(tx, m, true);
      });
      return strip(m);
    },

    async retryImageSummary(id) {
      await write(async (tx) => {
        const m = await mustGet(tx, id);
        if (!m.image || m.deletedAt) return;
        if (m.image.status !== 'failed' && m.image.status !== 'waiting') return;
        if (!(await tx.getImage(id))) throw new RepoError('not_found', '元画像がこの端末にありません');
        m.image = { ...m.image, status: 'waiting', error: null };
        await enqueueUpsert(tx, m, false);
      });
      internal.onImageQueued?.();
    },

    async cancelImageSummary(id) {
      await write(async (tx) => {
        const m = await mustGet(tx, id);
        await tx.deleteImage(id);
        if (!m.image || m.deletedAt || m.image.status === 'done') return;
        m.image = { ...m.image, status: 'cancelled' };
        await enqueueUpsert(tx, m, false);
      });
    },

    async getDraft(key) {
      await readyPromise;
      return backend.getDraft(key);
    },
    async setDraft(key, body) {
      await readyPromise;
      if (body.trim() === '') return backend.deleteDraft(key);
      const d: Draft = { key, body, updatedAt: nowIso() };
      await backend.putDraft(d);
    },
    async clearDraft(key) {
      await readyPromise;
      await backend.deleteDraft(key);
    },

    async exportAll(): Promise<ExportBundle> {
      await readyPromise;
      const memos: Memo[] = [];
      for (const m of cache.values()) {
        if (!isVisible(m)) continue;
        const { syncState: _s, syncError: _e, conflict: _c, serverVersion: _v, ...memo } = m;
        memos.push(structuredClone(memo));
      }
      memos.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      return { app: 'cuenu', format: 1, exportedAt: nowIso(), memos };
    },

    async importBundle(bundle) {
      if (!bundle || bundle.app !== 'cuenu' || bundle.format !== 1 || !Array.isArray(bundle.memos)) {
        throw new RepoError('invalid_bundle', 'Cuenu のエクスポートファイルではありません');
      }
      // 親を先に積む
      const list = [...bundle.memos]
        .filter(
          (m) =>
            m &&
            typeof m.id === 'string' &&
            typeof m.body === 'string' &&
            typeof m.createdAt === 'string' &&
            (m.parentId == null || typeof m.parentId === 'string') &&
            !m.deletedAt,
        )
        .sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId));
      return write(async (tx) => {
        let imported = 0;
        const ids = new Set<string>();
        for (const src of list) {
          if (await tx.getMemo(src.id)) continue;
          if (src.parentId && !ids.has(src.parentId) && !(await tx.getMemo(src.parentId))) continue;
          const memo: StoredMemo = {
            id: src.id,
            parentId: src.parentId ?? null,
            author: src.author === 'ai' ? 'ai' : 'user',
            body: src.body,
            createdAt: src.createdAt,
            updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : src.createdAt,
            editedAt: typeof src.editedAt === 'string' ? src.editedAt : null,
            version: 1,
            deletedAt: null,
            tags: Array.isArray(src.tags) ? src.tags.filter((t) => typeof t === 'string') : [],
            tagsVersion: null,
            emoji: typeof src.emoji === 'string' ? src.emoji : null,
            ai: src.ai ?? null,
            // 元画像は含まれないので要約待ちは取り込まない
            image: src.image && src.image.status === 'done' ? { ...src.image, baseVersion: 1 } : null,
            serverSeq: null,
            syncState: 'synced',
            syncError: null,
            conflict: null,
            serverVersion: 0,
          };
          if (memo.author === 'ai') {
            // AI 投稿はクライアントから作成できないため端末内にのみ取り込む
            memo.syncState = 'synced';
            await tx.putMemo(memo);
          } else {
            await enqueueUpsert(tx, memo, true);
          }
          ids.add(memo.id);
          imported++;
        }
        return { imported };
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return repo;
}

export function appendSummary(body: string, summary: string): string {
  const b = body.replace(/\s+$/, '');
  return b ? `${b}\n\n${summary}` : summary;
}
