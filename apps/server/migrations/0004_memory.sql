-- 長期記憶：古いメモを週・月ごとの要約として保持し、提案生成のときに全件の代わりに渡す
CREATE TABLE ai_memory (
  id TEXT PRIMARY KEY,                  -- 'week:2026-10-26' / 'month:2026-08'
  level TEXT NOT NULL,                  -- week | month
  period_start TEXT NOT NULL,           -- ユーザー TZ の日付（含む）
  period_end TEXT NOT NULL,             -- ユーザー TZ の日付（含まない）
  summary TEXT NOT NULL,
  topics TEXT NOT NULL DEFAULT '[]',    -- JSON string[]
  memo_count INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,            -- 元データの指紋。変わったら作り直す
  model TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ai_memory_level ON ai_memory(level, period_start);
