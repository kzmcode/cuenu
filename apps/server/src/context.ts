import type { AiClient } from './ai/client';
import type { Db } from './db';
import type { Env } from './env';

export interface Ctx {
  db: Db;
  env: Env;
  now: () => Date;
  /** AI 未設定なら null */
  ai: AiClient | null;
  /** Web Push 送信等の外部 fetch（テストで差し替え） */
  fetch: typeof fetch;
}
