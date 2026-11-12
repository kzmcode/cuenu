// サーバーAPI契約。すべて JSON。認証は `Authorization: Bearer <token>`（/api/health と /api/auth/login を除く）。
// エラーは { error: { code: ApiErrorCode, message: string, retryAfterSec?: number } } と適切な HTTP ステータス。

import type { IsoDate, Memo, SyncMemoPayload, UserSettings } from './types';

export const API_VERSION = 1;

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'bad_request'
  | 'not_found'
  | 'rate_limited' // 429。retryAfterSec を付与
  | 'ai_unavailable' // AI未設定・無効・上限
  | 'incompatible_client'
  | 'internal';

export interface ApiError {
  error: { code: ApiErrorCode; message: string; retryAfterSec?: number };
}

// GET /api/health （認証不要）
export interface HealthResponse {
  name: 'cuenu';
  apiVersion: number;
  minClientApiVersion: number;
  serverTime: IsoDate;
}

// POST /api/auth/login （認証不要）
// 所有者パスワード（サーバーSecret OWNER_PASSWORD）で認証し、端末トークンを発行。
// AIキーとは別物。失敗はレート制限される。
export interface LoginRequest {
  password: string;
  deviceName: string; // 例 "iPhone PWA", "Mac"
  deviceId?: string; // 既存端末IDの再ログイン時
}
export interface LoginResponse {
  token: string; // 長期の端末トークン（失効可能）
  deviceId: string;
}

// POST /api/auth/logout → 204（現トークン失効）
// GET  /api/devices → { devices: { deviceId, deviceName, createdAt, lastSeenAt, current: boolean }[] }
// DELETE /api/devices/:deviceId → 204

// POST /api/sync/push
export interface PushOp {
  opId: string;
  memoId: string;
  kind: 'upsert' | 'delete';
  baseVersion: number; // 新規は 0
  memo: SyncMemoPayload | null;
}
export interface PushRequest {
  deviceId: string;
  ops: PushOp[]; // 最大 100 件
}
export type PushResultStatus =
  | 'applied' // 適用
  | 'duplicate' // 同じ opId を適用済み（再送）。memo は現在のサーバー版
  | 'conflict' // サーバー版 != baseVersion。memo はサーバー版、クライアントは競合保持
  | 'gone' // 削除済み。memo は tombstone
  | 'rejected'; // 不正
export interface PushResult {
  opId: string;
  status: PushResultStatus;
  memo: Memo | null;
  message?: string;
}
export interface PushResponse {
  results: PushResult[];
  serverSeq: number; // 現在の最大 seq
}

// GET /api/sync/pull?since=<seq>&limit=<n≤500>
// since より大きい serverSeq の変更（tombstone 含む）を seq 昇順で返す
export interface PullResponse {
  changes: Memo[];
  nextSince: number; // 次回の since
  hasMore: boolean;
}

// サーバー競合規則:
// - upsert 新規(baseVersion=0): id が未存在なら作成。存在すれば opId 既適用→duplicate、違えば conflict。
// - upsert 編集: server.version === baseVersion なら version=baseVersion+1 で適用。異なれば conflict。
//   ※ payload.version は baseVersion+1 であること。
// - 削除: tombstone 化（deletedAt）。親削除時は返信も tombstone。削除済みへの upsert は gone。
// - author='ai' のメモ本文はクライアントから変更不可（削除＝非表示のみ可）。
//   ただし payload.liked（いいね）だけは変更可。version は上げない（payload.version===server.version、body 同一）。
// - image フィールドは version を上げずに更新可（要約状態の同期）。payload.version===server.version かつ
//   body 同一なら image のみ更新として applied。
// - tags/tagsVersion/emoji はサーバーAIのみが書き込む（emoji は tags と同時に付与）。変更時は serverSeq を進める（version は不変）。

// POST /api/images/summarize
// 画像はサーバーに保存せず、そのままAIへ転送し要約文のみ返す。
export interface ImageSummarizeRequest {
  memoId: string;
  mimeType: string; // image/png, image/jpeg, image/webp, image/heic
  dataBase64: string; // 最大 ~4MB（クライアントで縮小）
}
export interface ImageSummarizeResponse {
  summary: string;
  model: string;
}

// POST /api/search/semantic （オンライン時のみ）
export interface SemanticSearchRequest {
  query: string;
  limit?: number; // 既定 20
}
export interface SemanticSearchResponse {
  hits: { memoId: string; score: number }[];
  indexedCount: number;
  pendingCount: number;
}

// GET /api/settings → UserSettings / PUT /api/settings (Partial<UserSettings>) → UserSettings
export type SettingsResponse = UserSettings;

// GET /api/ai/status
export interface AiStatusResponse {
  configured: boolean;
  enabled: boolean;
  lastRunAt: IsoDate | null;
  lastError: string | null;
  postsToday: number;
  dailyLimit: number;
  pausedUntil: IsoDate | null; // レート制限で待機中
  pendingJobs: number;
}

// Web Push
// GET    /api/push/vapid-public-key → { publicKey: string }  (base64url)
// POST   /api/push/subscriptions { deviceId, subscription: PushSubscriptionJSON } → 204
// DELETE /api/push/subscriptions { endpoint } → 204
// 通知 payload: { title: 'Cuenu', body: string, memoId: string, url: `/?memo=${memoId}` }

// GET /api/export → { exportedAt, memos: Memo[] }
export interface ExportBundle {
  app: 'cuenu';
  format: 1;
  exportedAt: IsoDate;
  memos: Memo[];
}
