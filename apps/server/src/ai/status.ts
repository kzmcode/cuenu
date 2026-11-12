import type { Db } from '../db';
import { getState, setState } from '../db';

export const K = {
  lastRunAt: 'ai.lastRunAt',
  lastError: 'ai.lastError',
  pausedUntil: 'ai.pausedUntil',
};

export async function pausedUntil(db: Db, now: Date): Promise<string | null> {
  const v = await getState(db, K.pausedUntil);
  return v && Date.parse(v) > now.getTime() ? v : null;
}

export async function pauseAi(db: Db, now: Date, sec: number): Promise<string> {
  const until = new Date(now.getTime() + Math.min(sec, 24 * 3600) * 1000).toISOString();
  await setState(db, K.pausedUntil, until);
  return until;
}

export async function recordAiError(db: Db, msg: string): Promise<void> {
  await setState(db, K.lastError, msg.slice(0, 500));
}

export async function clearAiError(db: Db): Promise<void> {
  await db.run(`DELETE FROM kv_state WHERE key = ?`, K.lastError);
}
