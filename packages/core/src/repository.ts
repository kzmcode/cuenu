// UI が利用するクライアント側インターフェース。
// 実装: packages/core/src/client/ (IndexedDB 版 + インメモリ版)。Mac版は必要に応じて別アダプター。
// UI はこのインターフェースだけに依存し、保存方式・同期方式を知らない。

import type { ExportBundle } from './api';
import type { AuthorKind, Draft, IsoDate, LocalMemo, MemoWithMeta } from './types';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface SearchQuery {
  keyword?: string; // 日本語部分一致（NFKC・大文字小文字無視）。返信本文も対象
  tags?: string[]; // AND
  author?: AuthorKind;
  from?: IsoDate; // createdAt >= from
  to?: IsoDate; // createdAt < to
  cursor?: string | null;
  limit?: number; // 既定 30
}

export interface SearchHit {
  memo: MemoWithMeta; // ヒットしたメモ（返信の場合もある）
  /** 返信がヒットした場合の親スレッドID */
  threadId: string;
}

export interface CreateMemoInput {
  body: string;
  parentId?: string | null;
  /** 画像要約メモ。指定時は image.status='waiting' でローカル作成し、一時画像を保存 */
  image?: Blob | null;
}

export type RepoEvent =
  | { type: 'memo-changed'; ids: string[]; origin: 'local' | 'remote' }
  | { type: 'sync-status'; status: SyncStatus };

export interface SyncStatus {
  configured: boolean; // サーバー接続設定済み
  online: boolean;
  syncing: boolean;
  pendingOps: number;
  lastSyncedAt: IsoDate | null;
  lastError: string | null;
  /** 初回取り込みが完了しているか（未取得の記録をオフライン閲覧可能と表示しないため） */
  initialImportDone: boolean;
  conflicts: number;
}

export interface MemoRepository {
  /** ローカル保存成功で resolve（ネット待ちなし）。空白のみは reject */
  create(input: CreateMemoInput): Promise<LocalMemo>;
  updateBody(id: string, body: string): Promise<LocalMemo>;
  /** 親を消すと返信も消える。UI側で事前確認すること */
  remove(id: string): Promise<void>;
  /** 直前の削除を取り消す（同期前のみ確実） */
  undoRemove(id: string): Promise<void>;
  get(id: string): Promise<MemoWithMeta | null>;
  /** トップレベル、新しい順 */
  timeline(cursor?: string | null, limit?: number): Promise<Page<MemoWithMeta>>;
  /** 返信、古い順 */
  replies(parentId: string): Promise<MemoWithMeta[]>;
  search(q: SearchQuery): Promise<Page<SearchHit>>;
  /** 使用中のタグと件数 */
  tags(): Promise<{ tag: string; count: number }[]>;
  resolveConflict(id: string, resolution: 'keep-local' | 'keep-server' | { body: string }): Promise<LocalMemo>;
  /** 本文に自動反映できなかった画像要約を本文末尾へ反映 */
  applyImageSummary(id: string): Promise<LocalMemo>;
  /** AI 投稿への「いいね」を付け外しする（ローカル保存→同期） */
  setLiked(id: string, liked: boolean): Promise<LocalMemo>;
  retryImageSummary(id: string): Promise<void>;
  cancelImageSummary(id: string): Promise<void>;

  getDraft(key: string): Promise<Draft | null>;
  setDraft(key: string, body: string): Promise<void>;
  clearDraft(key: string): Promise<void>;

  exportAll(): Promise<ExportBundle>;
  importBundle(bundle: ExportBundle): Promise<{ imported: number }>;

  subscribe(listener: (e: RepoEvent) => void): () => void;
}

export interface ConnectionConfig {
  serverUrl: string; // 例 https://cuenu.example.workers.dev（PWA は同一オリジン）
  token: string;
  deviceId: string;
}

export interface SyncController {
  status(): SyncStatus;
  /** 即時同期（push → pull）。多重起動は1本にまとめる */
  syncNow(): Promise<void>;
  start(): void; // online/visibilitychange/interval で自動同期
  stop(): void;
}
