// Workers ランタイム型の最小定義（@cloudflare/workers-types に依存せず node テストと共用するため）。

export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta: { changes?: number; last_row_id?: number; [k: string]: unknown };
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
export interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}
export interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  // Secrets
  OWNER_PASSWORD?: string;
  GEMINI_API_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  // Vars
  GEMINI_MODEL?: string;
  GEMINI_EMBED_MODEL?: string;
  GEMINI_EMBED_DIM?: string;
  CORS_ORIGINS?: string;
  SEMANTIC_SCAN_LIMIT?: string;
  CRON_BATCH_SIZE?: string;
}

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_EMBED_MODEL = 'gemini-embedding-001';
export const DEFAULT_EMBED_DIM = 256;

export function intVar(v: string | undefined, def: number, min: number, max: number): number {
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
