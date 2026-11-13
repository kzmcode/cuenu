import type { Db } from './db';
import { stmt, type Stmt } from './db';

export type JobKind = 'tag' | 'embed';
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 12 * 3600_000;

export interface JobRow {
  kind: JobKind;
  target_id: string;
  target_version: number;
  status: 'pending' | 'done' | 'failed';
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
}

/** 新しい版のときだけ pending に戻す（同じ版の done/failed は再投入しない） */
export function enqueueStmt(kind: JobKind, targetId: string, version: number, now: string): Stmt {
  return stmt(
    `INSERT INTO jobs (kind, target_id, target_version, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
     ON CONFLICT(kind, target_id) DO UPDATE SET target_version = excluded.target_version, status = 'pending',
       attempts = 0, next_attempt_at = excluded.next_attempt_at, last_error = NULL, updated_at = excluded.updated_at
     WHERE excluded.target_version > jobs.target_version`,
    kind,
    targetId,
    version,
    now,
    now,
    now,
  );
}

export async function dueJobs(db: Db, kind: JobKind, now: Date, limit: number): Promise<JobRow[]> {
  return db.all<JobRow>(
    `SELECT * FROM jobs WHERE status = 'pending' AND kind = ? AND next_attempt_at <= ?
     ORDER BY next_attempt_at LIMIT ?`,
    kind,
    now.toISOString(),
    limit,
  );
}

export function doneStmt(j: JobRow, now: string): Stmt {
  // 処理中に新しい版が投入されていたら done にしない
  return stmt(
    `UPDATE jobs SET status = 'done', updated_at = ?, last_error = NULL
     WHERE kind = ? AND target_id = ? AND target_version = ?`,
    now,
    j.kind,
    j.target_id,
    j.target_version,
  );
}

function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

export function failStmt(j: JobRow, now: Date, error: string, retryAfterSec?: number): Stmt {
  const attempts = j.attempts + 1;
  const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  const wait = Math.max(backoffMs(attempts), (retryAfterSec ?? 0) * 1000);
  return stmt(
    `UPDATE jobs SET attempts = ?, status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
     WHERE kind = ? AND target_id = ? AND target_version = ?`,
    attempts,
    status,
    new Date(now.getTime() + wait).toISOString(),
    error.slice(0, 300),
    now.toISOString(),
    j.kind,
    j.target_id,
    j.target_version,
  );
}

export async function pendingJobCount(db: Db): Promise<number> {
  const r = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'`);
  return r?.n ?? 0;
}
