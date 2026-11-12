// IndexedDB 保存。ストア: memos / ops(送信キュー) / drafts / images(一時画像) / meta
// スキーマ変更は SCHEMA_VERSION を上げ、upgrade() に oldVersion ごとの移行を追記する。
// upgrade 内で例外が起きると versionchange トランザクションごと中止され、既存データはそのまま残る。

import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { Draft } from '../types';
import type { Backend, ImageRecord, StoredMemo, StoredOp, Tx } from './backend';

export const SCHEMA_VERSION = 1;

interface CuenuDB extends DBSchema {
  memos: { key: string; value: StoredMemo; indexes: { byParent: string } };
  ops: { key: string; value: StoredOp; indexes: { byMemo: string; bySeq: number } };
  drafts: { key: string; value: Draft };
  images: { key: string; value: ImageRecord };
  meta: { key: string; value: { key: string; value: unknown } };
}

const TX_STORES = ['memos', 'ops', 'meta', 'images'] as const;
type TxStores = typeof TX_STORES;

export interface IdbBackendOptions {
  /** 別タブが新しいスキーマへ更新しようとしている（このタブは接続を閉じた。再読み込みを促す） */
  onVersionChange?: () => void;
  /** 古いタブが接続を閉じないためアップグレード待ち */
  onBlocked?: () => void;
}

export async function openIdbBackend(name: string, opts: IdbBackendOptions = {}): Promise<Backend> {
  let db: IDBPDatabase<CuenuDB> | null = null;
  db = await openDB<CuenuDB>(name, SCHEMA_VERSION, {
    upgrade(udb, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        const memos = udb.createObjectStore('memos', { keyPath: 'id' });
        memos.createIndex('byParent', 'parentId');
        const ops = udb.createObjectStore('ops', { keyPath: 'opId' });
        ops.createIndex('byMemo', 'memoId');
        ops.createIndex('bySeq', 'seq');
        udb.createObjectStore('drafts', { keyPath: 'key' });
        udb.createObjectStore('images', { keyPath: 'memoId' });
        udb.createObjectStore('meta', { keyPath: 'key' });
      }
      // if (oldVersion < 2) { ...移行。tx.objectStore(...) で既存データを変換 }
      void tx.objectStore('meta').put({ key: 'schemaVersion', value: SCHEMA_VERSION });
    },
    blocked() {
      opts.onBlocked?.();
    },
    blocking() {
      // 新しい版のタブを妨げないよう閉じる
      db?.close();
      db = null;
      opts.onVersionChange?.();
    },
  });

  const conn = () => {
    if (!db) throw new Error('database closed (schema upgraded in another tab)');
    return db;
  };

  const makeTx = (t: IDBPTransaction<CuenuDB, TxStores, 'readwrite'>): Tx => {
    const memos = t.objectStore('memos');
    const ops = t.objectStore('ops');
    const meta = t.objectStore('meta');
    const images = t.objectStore('images');
    return {
      getMemo: (id) => memos.get(id),
      putMemo: async (m) => void (await memos.put(m)),
      childrenOf: (pid) => memos.index('byParent').getAll(pid),
      opsForMemo: async (mid) => (await ops.index('byMemo').getAll(mid)).sort((a, b) => a.seq - b.seq),
      allOps: () => ops.index('bySeq').getAll(),
      putOp: async (o) => void (await ops.put(o)),
      deleteOp: (id) => ops.delete(id),
      getMeta: async <T>(k: string) => (await meta.get(k))?.value as T | undefined,
      setMeta: async (k, v) => void (await meta.put({ key: k, value: v })),
      getImage: (id) => images.get(id),
      putImage: async (r) => void (await images.put(r)),
      deleteImage: (id) => images.delete(id),
    };
  };

  return {
    name,
    async transact<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      const t = conn().transaction([...TX_STORES], 'readwrite');
      let result: T;
      try {
        result = await fn(makeTx(t));
      } catch (e) {
        try {
          t.abort();
        } catch {
          /* already finished */
        }
        await t.done.catch(() => undefined);
        throw e;
      }
      await t.done;
      return result;
    },
    loadAllMemos: () => conn().getAll('memos'),
    async getMemos(ids) {
      const t = conn().transaction('memos');
      const out = await Promise.all(ids.map((id) => t.store.get(id)));
      await t.done;
      return out;
    },
    countOps: () => conn().count('ops'),
    getMeta: async <T>(k: string) => (await conn().get('meta', k))?.value as T | undefined,
    listImageIds: () => conn().getAllKeys('images'),
    getImage: (id) => conn().get('images', id),
    getDraft: async (k) => (await conn().get('drafts', k)) ?? null,
    putDraft: async (d) => void (await conn().put('drafts', d)),
    deleteDraft: (k) => conn().delete('drafts', k),
    close() {
      db?.close();
      db = null;
    },
  };
}
