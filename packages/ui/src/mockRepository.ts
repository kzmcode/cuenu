// 開発・テスト用の簡易インメモリ MemoRepository。
// 本番は担当B の createIdbRepository / createMemoryRepository を使う。永続化しない。
import type {
  CreateMemoInput,
  Draft,
  ExportBundle,
  LocalMemo,
  MemoRepository,
  MemoWithMeta,
  Page,
  RepoEvent,
  SearchHit,
  SearchQuery,
} from '@cuenu/core';

const norm = (s: string) => s.normalize('NFKC').toLowerCase();

export interface MockRepository extends MemoRepository {
  /** テスト用: サーバーから届いたように追加・更新する */
  injectRemote(memo: Partial<LocalMemo> & { id: string }): void;
  /** テスト用: 次の create を失敗させる */
  failNextCreate(message?: string): void;
}

export function createMockRepository(seed: Partial<LocalMemo>[] = []): MockRepository {
  const memos = new Map<string, LocalMemo>();
  const removed = new Map<string, LocalMemo[]>();
  const drafts = new Map<string, Draft>();
  const listeners = new Set<(e: RepoEvent) => void>();
  let failNext: string | null = null;
  let clock = Date.parse('2026-11-01T00:00:00.000Z');
  const now = () => new Date((clock += 1000)).toISOString();

  const make = (p: Partial<LocalMemo> & { id?: string }): LocalMemo => {
    const t = p.createdAt ?? now();
    return {
      id: p.id ?? crypto.randomUUID(),
      parentId: null,
      author: 'user',
      body: '',
      createdAt: t,
      updatedAt: t,
      editedAt: null,
      version: 1,
      deletedAt: null,
      tags: [],
      tagsVersion: null,
      emoji: null,
      ai: null,
      image: null,
      serverSeq: null,
      syncState: 'synced',
      syncError: null,
      conflict: null,
      ...p,
    };
  };
  for (const s of seed) {
    const m = make(s);
    memos.set(m.id, m);
  }

  const emit = (ids: string[], origin: 'local' | 'remote' = 'local') => {
    for (const l of listeners) l({ type: 'memo-changed', ids, origin });
  };
  const withMeta = (m: LocalMemo): MemoWithMeta => ({
    ...m,
    replyCount: [...memos.values()].filter((r) => r.parentId === m.id && !r.deletedAt).length,
  });
  const live = () => [...memos.values()].filter((m) => !m.deletedAt);
  const byNewest = (a: LocalMemo, b: LocalMemo) => (a.createdAt < b.createdAt ? 1 : -1);
  const page = <T,>(all: T[], cursor: string | null | undefined, limit: number): Page<T> => {
    const start = cursor ? Number(cursor) : 0;
    const items = all.slice(start, start + limit);
    return { items, nextCursor: start + limit < all.length ? String(start + limit) : null };
  };
  const mustGet = (id: string) => {
    const m = memos.get(id);
    if (!m || m.deletedAt) throw new Error('not found');
    return m;
  };
  const put = (m: LocalMemo) => {
    memos.set(m.id, m);
    emit([m.id]);
    return m;
  };

  return {
    async create(input: CreateMemoInput) {
      if (failNext !== null) {
        const msg = failNext;
        failNext = null;
        throw new Error(msg);
      }
      if (!input.body.trim() && !input.image) throw new Error('empty');
      const m = make({
        body: input.body,
        parentId: input.parentId ?? null,
        syncState: 'pending',
        image: input.image
          ? { status: 'waiting', originDeviceId: 'mock-device', summary: null, applied: false, error: null, baseVersion: 1 }
          : null,
      });
      return put(m);
    },
    async updateBody(id, body) {
      const m = mustGet(id);
      const t = now();
      return put({ ...m, body, version: m.version + 1, editedAt: t, updatedAt: t, syncState: 'pending' });
    },
    async setLiked(id, liked) {
      const m = mustGet(id);
      if (m.author !== 'ai') throw new Error('いいねは AI の投稿にだけ付けられます');
      return put({ ...m, liked, updatedAt: now(), syncState: 'pending' });
    },
    async remove(id) {
      const m = mustGet(id);
      const t = now();
      const victims = [m, ...live().filter((r) => r.parentId === id)];
      removed.set(id, victims);
      for (const v of victims) memos.set(v.id, { ...v, deletedAt: t });
      emit(victims.map((v) => v.id));
    },
    async undoRemove(id) {
      const victims = removed.get(id);
      if (!victims) throw new Error('nothing to undo');
      for (const v of victims) memos.set(v.id, v);
      removed.delete(id);
      emit(victims.map((v) => v.id));
    },
    async get(id) {
      const m = memos.get(id);
      return m ? withMeta(m) : null;
    },
    async timeline(cursor, limit = 30) {
      return page(live().filter((m) => m.parentId === null).sort(byNewest).map(withMeta), cursor, limit);
    },
    async replies(parentId) {
      return live()
        .filter((m) => m.parentId === parentId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        .map(withMeta);
    },
    async search(q: SearchQuery) {
      const kw = q.keyword ? norm(q.keyword) : null;
      const hits: SearchHit[] = live()
        .filter((m) => (!kw || norm(m.body).includes(kw)) && (!q.author || m.author === q.author) && (!q.from || m.createdAt >= q.from) && (!q.to || m.createdAt < q.to) && (q.tags ?? []).every((t) => m.tags.includes(t)))
        .sort(byNewest)
        .map((m) => ({ memo: withMeta(m), threadId: m.parentId ?? m.id }));
      return page(hits, q.cursor, q.limit ?? 30);
    },
    async tags() {
      const c = new Map<string, number>();
      for (const m of live()) for (const t of m.tags) c.set(t, (c.get(t) ?? 0) + 1);
      return [...c].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
    },
    async resolveConflict(id, resolution) {
      const m = mustGet(id);
      const body = resolution === 'keep-local' ? (m.conflict?.localBody ?? m.body) : resolution === 'keep-server' ? (m.conflict?.server.body ?? m.body) : resolution.body;
      return put({ ...m, body, conflict: null, syncState: resolution === 'keep-server' ? 'synced' : 'pending' });
    },
    async applyImageSummary(id) {
      const m = mustGet(id);
      if (!m.image?.summary) throw new Error('no summary');
      return put({ ...m, body: `${m.body}\n\n${m.image.summary}`.trim(), image: { ...m.image, applied: true }, version: m.version + 1 });
    },
    async retryImageSummary(id) {
      const m = mustGet(id);
      if (m.image) put({ ...m, image: { ...m.image, status: 'waiting', error: null } });
    },
    async cancelImageSummary(id) {
      const m = mustGet(id);
      if (m.image) put({ ...m, image: { ...m.image, status: 'cancelled' } });
    },
    async getDraft(key) {
      return drafts.get(key) ?? null;
    },
    async setDraft(key, body) {
      drafts.set(key, { key, body, updatedAt: new Date().toISOString() });
    },
    async clearDraft(key) {
      drafts.delete(key);
    },
    async exportAll(): Promise<ExportBundle> {
      return {
        app: 'cuenu',
        format: 1,
        exportedAt: new Date().toISOString(),
        memos: [...memos.values()].map(({ syncState: _s, syncError: _e, conflict: _c, ...m }) => m),
      };
    },
    async importBundle(bundle) {
      let imported = 0;
      for (const m of bundle.memos) {
        if (memos.has(m.id)) continue;
        memos.set(m.id, { ...m, syncState: 'synced', syncError: null, conflict: null });
        imported++;
      }
      emit(bundle.memos.map((m) => m.id));
      return { imported };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    injectRemote(p) {
      const prev = memos.get(p.id);
      const m = prev ? { ...prev, ...p } : make(p);
      memos.set(m.id, m);
      emit([m.id], 'remote');
    },
    failNextCreate(message = 'disk full') {
      failNext = message;
    },
  };
}
