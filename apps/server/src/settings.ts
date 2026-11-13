import { DEFAULT_SETTINGS, type UserSettings } from '@cuenu/core';
import type { Db } from './db';
import { badRequest } from './http';
import { isValidTimeZone } from './util';

const MAX_DAILY_LIMIT = 10;

export async function getSettings(db: Db): Promise<UserSettings> {
  const r = await db.first<{ value: string }>(`SELECT value FROM settings WHERE key = 'user'`);
  let stored: Partial<UserSettings> = {};
  if (r) {
    try {
      stored = JSON.parse(r.value) as Partial<UserSettings>;
    } catch {
      stored = {};
    }
  }
  return { ...DEFAULT_SETTINGS, ...stored };
}

function validateSettingsPatch(patch: unknown): Partial<UserSettings> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw badRequest('settings must be an object');
  const p = patch as Record<string, unknown>;
  const out: Partial<UserSettings> = {};
  if ('timezone' in p) {
    if (typeof p.timezone !== 'string' || !isValidTimeZone(p.timezone)) throw badRequest('invalid timezone');
    out.timezone = p.timezone;
  }
  if ('dailyAiPostLimit' in p) {
    const n = p.dailyAiPostLimit;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_DAILY_LIMIT) {
      throw badRequest(`dailyAiPostLimit must be an integer 0..${MAX_DAILY_LIMIT}`);
    }
    out.dailyAiPostLimit = n;
  }
  for (const k of ['notificationDetail', 'aiEnabled'] as const) {
    if (k in p) {
      if (typeof p[k] !== 'boolean') throw badRequest(`${k} must be boolean`);
      out[k] = p[k] as boolean;
    }
  }
  return out;
}

export async function putSettings(db: Db, patch: unknown): Promise<UserSettings> {
  const next = { ...(await getSettings(db)), ...validateSettingsPatch(patch) };
  await db.run(
    `INSERT INTO settings (key, value) VALUES ('user', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    JSON.stringify(next),
  );
  return next;
}
