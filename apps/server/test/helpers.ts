import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AiClient, EmbedTask, GenerateOptions } from '../src/ai/client';
import type { Ctx } from '../src/context';
import type { Db, Stmt } from '../src/db';
import type { Env } from '../src/env';

const norm = (ps: unknown[]) =>
  ps.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)) as (string | number | null)[];

/** node:sqlite による Db 実装（D1 と同じ SQLite 方言） */
export function sqliteDb(): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  const dir = join(import.meta.dirname, '..', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  return {
    raw,
    async all<T>(sql: string, ...params: unknown[]) {
      return raw.prepare(sql).all(...norm(params)) as T[];
    },
    async first<T>(sql: string, ...params: unknown[]) {
      return (raw.prepare(sql).get(...norm(params)) as T | undefined) ?? null;
    },
    async run(sql: string, ...params: unknown[]) {
      return { changes: Number(raw.prepare(sql).run(...norm(params)).changes) };
    },
    async batch(stmts: Stmt[]) {
      raw.exec('BEGIN');
      try {
        const out = stmts.map((s) => ({ changes: Number(raw.prepare(s.sql).run(...norm(s.params)).changes) }));
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

export class MockAi implements AiClient {
  model = 'mock-model';
  embedModel = 'mock-embed';
  embedDim = 8;
  calls: GenerateOptions[] = [];
  embedCalls: { texts: string[]; task: EmbedTask }[] = [];
  handler: (o: GenerateOptions) => Promise<string> | string = () => '{}';
  async generate(o: GenerateOptions) {
    this.calls.push(o);
    return this.handler(o);
  }
  async embed(texts: string[], task: EmbedTask) {
    this.embedCalls.push({ texts, task });
    // 文字コードから決定的なベクトル
    return texts.map((t) => {
      const v = new Array(this.embedDim).fill(0);
      for (const ch of t) v[ch.charCodeAt(0) % this.embedDim] += 1;
      return v;
    });
  }
}

export interface TestCtx extends Ctx {
  db: Db & { raw: DatabaseSync };
  clock: { t: number };
  ai: MockAi | null;
}

export function makeCtx(opts: { env?: Partial<Env>; ai?: MockAi | null; fetch?: typeof fetch } = {}): TestCtx {
  const db = sqliteDb();
  const clock = { t: Date.parse('2026-11-04T03:00:00.000Z') };
  const env = { DB: null as never, OWNER_PASSWORD: 'secret-pw', ...opts.env } as Env;
  return {
    db,
    env,
    clock,
    now: () => new Date(clock.t),
    ai: opts.ai === undefined ? new MockAi() : opts.ai,
    fetch: opts.fetch ?? (async () => new Response(null, { status: 201 })),
  };
}

export function req(path: string, init: RequestInit & { token?: string; json?: unknown } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  return new Request(`https://cuenu.example.com${path}`, { ...init, headers, body });
}
