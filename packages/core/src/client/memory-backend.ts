import type { Draft } from '../types';
import type { Backend, ImageRecord, StoredMemo, StoredOp, Tx } from './backend';
import { createMutex } from './util';

const DELETED = Symbol('deleted');
type Staged<T> = Map<string, T | typeof DELETED>;

const clone = <T>(v: T): T => structuredClone(v);

/** インメモリ保存（テスト・未接続プレビュー用）。トランザクションは失敗時に破棄される */
export function createMemoryBackend(name = 'cuenu:memory'): Backend {
  const memos = new Map<string, StoredMemo>();
  const ops = new Map<string, StoredOp>();
  const meta = new Map<string, unknown>();
  const images = new Map<string, ImageRecord>();
  const drafts = new Map<string, Draft>();
  const lock = createMutex();

  const read = <T>(base: Map<string, T>, staged: Staged<T>, key: string): T | undefined => {
    const s = staged.get(key);
    if (s === DELETED) return undefined;
    if (s !== undefined) return clone(s);
    const b = base.get(key);
    return b === undefined ? undefined : clone(b);
  };
  const values = <T>(base: Map<string, T>, staged: Staged<T>): T[] => {
    const keys = new Set([...base.keys(), ...staged.keys()]);
    const out: T[] = [];
    for (const k of keys) {
      const v = read(base, staged, k);
      if (v !== undefined) out.push(v);
    }
    return out;
  };
  const commit = <T>(base: Map<string, T>, staged: Staged<T>) => {
    for (const [k, v] of staged) {
      if (v === DELETED) base.delete(k);
      else base.set(k, v);
    }
  };

  return {
    name,
    transact<T>(fn: (tx: Tx) => Promise<T>) {
      return lock(async () => {
        const sm: Staged<StoredMemo> = new Map();
        const so: Staged<StoredOp> = new Map();
        const smeta: Staged<unknown> = new Map();
        const si: Staged<ImageRecord> = new Map();
        const tx: Tx = {
          getMemo: async (id) => read(memos, sm, id),
          putMemo: async (m) => void sm.set(m.id, clone(m)),
          childrenOf: async (pid) => values(memos, sm).filter((m) => m.parentId === pid),
          opsForMemo: async (mid) =>
            values(ops, so)
              .filter((o) => o.memoId === mid)
              .sort((a, b) => a.seq - b.seq),
          allOps: async () => values(ops, so).sort((a, b) => a.seq - b.seq),
          putOp: async (o) => void so.set(o.opId, clone(o)),
          deleteOp: async (id) => void so.set(id, DELETED),
          getMeta: async <V>(k: string) => read(meta, smeta, k) as V | undefined,
          setMeta: async (k, v) => void smeta.set(k, clone(v)),
          getImage: async (id) => {
            const s = si.get(id);
            if (s === DELETED) return undefined;
            return s ?? images.get(id);
          },
          putImage: async (r) => void si.set(r.memoId, r),
          deleteImage: async (id) => void si.set(id, DELETED),
        };
        const result = await fn(tx);
        commit(memos, sm);
        commit(ops, so);
        commit(meta, smeta);
        commit(images, si);
        return result;
      });
    },
    loadAllMemos: async () => [...memos.values()].map(clone),
    getMemos: async (ids) => ids.map((id) => (memos.has(id) ? clone(memos.get(id)!) : undefined)),
    countOps: async () => ops.size,
    getMeta: async <T>(k: string) => (meta.has(k) ? (clone(meta.get(k)) as T) : undefined),
    listImageIds: async () => [...images.keys()],
    getImage: async (id) => images.get(id),
    getDraft: async (k) => (drafts.has(k) ? clone(drafts.get(k)!) : null),
    putDraft: async (d) => void drafts.set(d.key, clone(d)),
    deleteDraft: async (k) => void drafts.delete(k),
    close() {},
  };
}
