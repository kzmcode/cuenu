import type { D1Database } from './env';

export interface Stmt {
  sql: string;
  params: unknown[];
}
export interface RunResult {
  changes: number;
}

/** D1 を薄く包んだ DB インターフェース。テストでは node:sqlite 実装に差し替える。 */
export interface Db {
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  first<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  run(sql: string, ...params: unknown[]): Promise<RunResult>;
  /** 1 トランザクションで順に実行（D1 batch は原子的） */
  batch(stmts: Stmt[]): Promise<RunResult[]>;
}

export const stmt = (sql: string, ...params: unknown[]): Stmt => ({ sql, params });

function norm(params: unknown[]): unknown[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

export function d1Db(d1: D1Database): Db {
  const prep = (sql: string, params: unknown[]) => d1.prepare(sql).bind(...norm(params));
  return {
    async all<T>(sql: string, ...params: unknown[]) {
      return ((await prep(sql, params).all<T>()).results ?? []) as T[];
    },
    async first<T>(sql: string, ...params: unknown[]) {
      return (await prep(sql, params).first<T>()) ?? null;
    },
    async run(sql: string, ...params: unknown[]) {
      const r = await prep(sql, params).run();
      return { changes: Number(r.meta.changes ?? 0) };
    },
    async batch(stmts: Stmt[]) {
      if (stmts.length === 0) return [];
      const rs = await d1.batch(stmts.map((s) => prep(s.sql, s.params)));
      return rs.map((r) => ({ changes: Number(r.meta.changes ?? 0) }));
    },
  };
}

/** seq カウンタを進める SQL（batch 内で直後の文から SEQ_VALUE で参照する） */
export const BUMP_SEQ = stmt(`UPDATE counters SET value = value + 1 WHERE name = 'seq'`);
export const SEQ_VALUE = `(SELECT value FROM counters WHERE name = 'seq')`;

export async function currentSeq(db: Db): Promise<number> {
  const r = await db.first<{ value: number }>(`SELECT value FROM counters WHERE name = 'seq'`);
  return r?.value ?? 0;
}

export async function getState(db: Db, key: string): Promise<string | null> {
  const r = await db.first<{ value: string }>(`SELECT value FROM kv_state WHERE key = ?`, key);
  return r?.value ?? null;
}
export function setStateStmt(key: string, value: string): Stmt {
  return stmt(
    `INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  );
}
export async function setState(db: Db, key: string, value: string): Promise<void> {
  const s = setStateStmt(key, value);
  await db.run(s.sql, ...s.params);
}

/** リース型ロック。取得できたら true。期限切れなら奪取可能 */
export async function acquireLock(db: Db, name: string, owner: string, now: Date, leaseMs: number): Promise<boolean> {
  const exp = new Date(now.getTime() + leaseMs).toISOString();
  const r = await db.run(
    `INSERT INTO locks (name, owner, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
     WHERE locks.expires_at < ?`,
    name,
    owner,
    exp,
    now.toISOString(),
  );
  return r.changes > 0;
}
export async function releaseLock(db: Db, name: string, owner: string): Promise<void> {
  await db.run(`DELETE FROM locks WHERE name = ? AND owner = ?`, name, owner);
}
