-- AI 投稿へのいいね（ユーザーが付ける）
ALTER TABLE memos ADD COLUMN liked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memos ADD COLUMN liked_at TEXT;

-- AI 投稿ごとの反応の評価（定期処理で再計算）。提案生成のプロンプトと種別ごとのしきい値に使う
CREATE TABLE ai_feedback (
  memo_id TEXT PRIMARY KEY,             -- AI 投稿の memo id
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  signal TEXT NOT NULL,                 -- liked/adopted/done/later/declined/hidden/ignored/replied/pending
  score REAL NOT NULL,                  -- -1..1
  evaluated_at TEXT NOT NULL
);

-- AI 投稿への返信の分類（本文版ごと。編集されたら再分類）
CREATE TABLE ai_reply_labels (
  reply_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  label TEXT NOT NULL,                  -- adopted/done/later/declined/neutral
  labeled_at TEXT NOT NULL
);
