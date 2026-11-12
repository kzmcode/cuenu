// 保存方式の抽象。リポジトリのロジックはこの上に1つだけ実装し、IndexedDB 版とインメモリ版で共有する。

import type { Draft, LocalMemo, PendingOp } from '../types';

/** 保存されるメモ（UI へ返す前に内部フィールドを除く） */
export interface StoredMemo extends LocalMemo {
  /** 最後に確認したサーバー側の本文版。未送信の新規は 0 */
  serverVersion: number;
}

/** 保存される送信キュー要素 */
export interface StoredOp extends PendingOp {
  /** キュー内順序 */
  seq: number;
  /** 送信中（結果待ち）。送信中の op は圧縮対象にしない */
  sending: boolean;
}

/** 画像要約待ちの一時画像 */
export interface ImageRecord {
  memoId: string;
  mimeType: string;
  data: ArrayBuffer;
  createdAt: string;
}

export interface Tx {
  getMemo(id: string): Promise<StoredMemo | undefined>;
  putMemo(m: StoredMemo): Promise<void>;
  childrenOf(parentId: string): Promise<StoredMemo[]>;
  /** seq 昇順 */
  opsForMemo(memoId: string): Promise<StoredOp[]>;
  /** seq 昇順 */
  allOps(): Promise<StoredOp[]>;
  putOp(op: StoredOp): Promise<void>;
  deleteOp(opId: string): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  getImage(memoId: string): Promise<ImageRecord | undefined>;
  putImage(rec: ImageRecord): Promise<void>;
  deleteImage(memoId: string): Promise<void>;
}

export interface Backend {
  readonly name: string;
  /**
   * memos/ops/meta/images を1トランザクションで読み書き。fn が throw したら何も書かれない。
   * fn の中では Tx 以外の非同期処理（fetch 等）を await しないこと（IndexedDB の自動コミット対策）。
   */
  transact<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  loadAllMemos(): Promise<StoredMemo[]>;
  getMemos(ids: string[]): Promise<(StoredMemo | undefined)[]>;
  countOps(): Promise<number>;
  getMeta<T>(key: string): Promise<T | undefined>;
  listImageIds(): Promise<string[]>;
  getImage(memoId: string): Promise<ImageRecord | undefined>;
  getDraft(key: string): Promise<Draft | null>;
  putDraft(d: Draft): Promise<void>;
  deleteDraft(key: string): Promise<void>;
  close(): void;
}
