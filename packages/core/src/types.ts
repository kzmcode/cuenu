// Cuenu 共通データ型（クライアント・サーバー共通の契約）。
// 変更は後方互換の追加のみとし、サーバー・クライアント・UI をそろえて更新すること。

export type AuthorKind = 'user' | 'ai';
export type AiPostKind = 'action' | 'related' | 'reflection';

/** ISO8601 UTC 文字列 (例: 2026-11-04T05:00:00.000Z) */
export type IsoDate = string;

export interface AiMeta {
  kind: AiPostKind;
  /** 参照元メモID（返信IDも可） */
  sourceIds: string[];
  /** 参照時の各メモの版番号 (sourceIds と同順) */
  sourceVersions: number[];
  model: string;
  /** 冪等性キー（同一処理での二重登録防止） */
  jobId: string;
}

export type ImageSummaryStatus = 'waiting' | 'processing' | 'done' | 'failed' | 'cancelled';

export interface ImageSummaryState {
  status: ImageSummaryStatus;
  /** 元画像を保持している端末。他端末は要約処理を進められない */
  originDeviceId: string;
  /** 要約文。本文へ自動反映できなかった場合もここに残す */
  summary: string | null;
  /** 要約文を本文へ反映済みか */
  applied: boolean;
  error: string | null;
  /** 画像メモ作成時の本文版。要約完了時に version と一致すれば自動反映してよい */
  baseVersion: number;
}

/** 投稿・返信の共通レコード。parentId が null ならトップレベル投稿 */
export interface Memo {
  id: string; // 端末生成 UUID (crypto.randomUUID)。AI投稿はサーバー生成
  parentId: string | null;
  author: AuthorKind;
  body: string; // Markdown
  createdAt: IsoDate;
  updatedAt: IsoDate; // 何らかの変更（タグ含む）日時
  editedAt: IsoDate | null; // 本文編集日時。null なら未編集
  version: number; // 本文の版番号。作成時 1、本文編集ごとに +1
  deletedAt: IsoDate | null; // 削除記録（tombstone）
  tags: string[]; // 自動タグ（サーバーAIが付与）
  tagsVersion: number | null; // tags を解析した本文版
  /** AI が本文から選ぶ絵文字1つ（アバター代わりに表示）。tags と同じ処理・同じ tagsVersion で付与。未付与は null */
  emoji?: string | null;
  /** AI 投稿への「いいね」（ユーザーが付ける。AI の提案精度の参考にする）。AI 投稿以外では常に false/undefined */
  liked?: boolean;
  ai: AiMeta | null;
  image: ImageSummaryState | null;
  /** サーバーの変更順序。未同期なら null */
  serverSeq: number | null;
}

// ---- 端末ローカル専用 ----

export type LocalSyncState = 'pending' | 'synced' | 'error' | 'conflict';

export interface ConflictInfo {
  /** サーバー側で既に確定していた版 */
  server: Memo;
  /** この端末で編集していた本文 */
  localBody: string;
  localBaseVersion: number;
  detectedAt: IsoDate;
}

export interface LocalMemo extends Memo {
  syncState: LocalSyncState;
  syncError: string | null;
  conflict: ConflictInfo | null;
}

export interface MemoWithMeta extends LocalMemo {
  replyCount: number;
}

/** 永続化送信キューの1操作 */
export interface PendingOp {
  opId: string; // UUID。サーバーで冪等性キーとして扱う
  memoId: string;
  kind: 'upsert' | 'delete';
  /** 編集元の本文版。新規作成は 0 */
  baseVersion: number;
  /** upsert 時のメモ内容（送信時点のスナップショット） */
  memo: SyncMemoPayload | null;
  createdAt: IsoDate;
  attempts: number;
  lastError: string | null;
}

/** クライアント→サーバーへ送るメモ内容（サーバー管理フィールドを除く） */
export interface SyncMemoPayload {
  id: string;
  parentId: string | null;
  body: string;
  createdAt: IsoDate;
  editedAt: IsoDate | null;
  version: number;
  image: ImageSummaryState | null;
  /** AI 投稿の「いいね」。AI 投稿にのみ送る（本文・版は変えない） */
  liked?: boolean;
}

export interface Draft {
  key: string; // 'quick' | 'main' | `reply:${parentId}` | `edit:${memoId}`
  body: string;
  updatedAt: IsoDate;
}

export type ThemePreference = 'system' | 'light' | 'dark';

export interface UserSettings {
  timezone: string; // 既定 Asia/Tokyo
  dailyAiPostLimit: number; // 既定 3
  notificationDetail: boolean; // 既定 false（ロック画面に本文を出さない）
  aiEnabled: boolean; // 既定 true
}

export const DEFAULT_SETTINGS: UserSettings = {
  timezone: 'Asia/Tokyo',
  dailyAiPostLimit: 3,
  notificationDetail: false,
  aiEnabled: true,
};
