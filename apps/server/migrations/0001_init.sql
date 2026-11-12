-- Cuenu D1 schema v1

-- 投稿・返信（parent_id で統一）。tombstone は deleted_at。
CREATE TABLE memos (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  author TEXT NOT NULL CHECK (author IN ('user', 'ai')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  edited_at TEXT,
  version INTEGER NOT NULL,
  deleted_at TEXT,
  tags TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
  tags_version INTEGER,
  ai TEXT,                              -- JSON AiMeta
  image TEXT,                           -- JSON ImageSummaryState
  server_seq INTEGER NOT NULL,
  last_op_id TEXT
);
CREATE UNIQUE INDEX memos_seq ON memos(server_seq);
CREATE INDEX memos_parent ON memos(parent_id);
CREATE INDEX memos_created ON memos(created_at);

-- 単調増加カウンタ
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO counters (name, value) VALUES ('seq', 0);

-- 同期履歴（opId の冪等性）
CREATE TABLE sync_ops (
  op_id TEXT PRIMARY KEY,
  memo_id TEXT NOT NULL,
  device_id TEXT,
  kind TEXT NOT NULL,
  server_seq INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE INDEX sync_ops_applied ON sync_ops(applied_at);
CREATE INDEX sync_ops_seq ON sync_ops(server_seq);

-- 端末（トークンはハッシュのみ）
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- ログイン失敗のレート制限
CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  locked_until TEXT
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE kv_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at TEXT NOT NULL);

-- 処理ジョブ（タグ付与・埋め込み）
CREATE TABLE jobs (
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, target_id)
);
CREATE INDEX jobs_due ON jobs(status, next_attempt_at);

-- 埋め込み（int8 量子化ベクトルを base64 で保存）
CREATE TABLE embeddings (
  memo_id TEXT PRIMARY KEY,
  body_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector TEXT NOT NULL,                 -- base64(Int8Array)
  scale REAL NOT NULL,                  -- 量子化スケール（正規化後の最大絶対値）
  memo_created_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX embeddings_recent ON embeddings(model, dim, memo_created_at);

-- AI 投稿の記録（日次上限・重複防止・通知済み管理）。削除されても上限計算に残す
CREATE TABLE ai_posts (
  job_id TEXT PRIMARY KEY,
  memo_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,                    -- ユーザー TZ の日付
  source_key TEXT NOT NULL,             -- ソート済み sourceIds
  summary TEXT NOT NULL,                -- 既出提案の要約（重複判定用）
  created_at TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ai_posts_day ON ai_posts(day);

-- Web Push 購読
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  device_id TEXT,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_error TEXT
);
-- 通知済み（memo×購読）で重複通知を防ぐ
CREATE TABLE push_deliveries (
  memo_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (memo_id, endpoint)
);
