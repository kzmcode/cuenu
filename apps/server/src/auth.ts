import type { LoginRequest, LoginResponse } from '@cuenu/core';
import type { Ctx } from './context';
import { stmt } from './db';
import { HttpError, badRequest } from './http';
import { randomToken, sha256Hex, utf8 } from './util';

export interface DeviceRow {
  id: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  pw_fp: string | null;
}

export const RATE = {
  ipMaxFailures: 5,
  ipWindowMs: 15 * 60_000,
  ipLockMs: 15 * 60_000,
  globalMaxFailures: 20,
  globalWindowMs: 60 * 60_000,
  globalLockMs: 60 * 60_000,
};
const LAST_SEEN_THROTTLE_MS = 5 * 60_000;

async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  // ハッシュ同士を比較して長さ差と早期終了を避ける
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', utf8(a)),
    crypto.subtle.digest('SHA-256', utf8(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

let fpCache: { pw: string; fp: string } | null = null;

/** OWNER_PASSWORD の指紋。端末をログイン時のパスワードに結び付け、変更されたら失効させる */
export async function passwordFingerprint(password: string): Promise<string> {
  if (fpCache?.pw === password) return fpCache.fp;
  const key = await crypto.subtle.importKey('raw', utf8(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8('cuenu-device-binding-v1')));
  const fp = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
  fpCache = { pw: password, fp };
  return fp;
}

/** パスワード変更前にログインした端末（と Push 購読）を削除する。移行前の端末（pw_fp NULL）は残す */
export async function purgeStaleDevices(ctx: Ctx): Promise<void> {
  if (!ctx.env.OWNER_PASSWORD) return;
  const fp = await passwordFingerprint(ctx.env.OWNER_PASSWORD);
  await ctx.db.batch([
    stmt(
      `DELETE FROM push_subscriptions WHERE device_id IN (SELECT id FROM devices WHERE pw_fp IS NOT NULL AND pw_fp != ?)`,
      fp,
    ),
    stmt(`DELETE FROM devices WHERE pw_fp IS NOT NULL AND pw_fp != ?`, fp),
  ]);
}

interface AttemptRow {
  key: string;
  failures: number;
  window_start: string;
  locked_until: string | null;
}

async function checkLocked(ctx: Ctx, keys: string[]): Promise<void> {
  const now = ctx.now().getTime();
  for (const key of keys) {
    const r = await ctx.db.first<AttemptRow>(`SELECT * FROM login_attempts WHERE key = ?`, key);
    if (r?.locked_until && Date.parse(r.locked_until) > now) {
      const sec = Math.ceil((Date.parse(r.locked_until) - now) / 1000);
      throw new HttpError(429, 'rate_limited', 'too many login attempts', sec);
    }
  }
}

interface Limit {
  key: string;
  max: number;
  windowMs: number;
  lockMs: number;
}

function limitsFor(ip: string): Limit[] {
  return [
    { key: `ip:${ip}`, max: RATE.ipMaxFailures, windowMs: RATE.ipWindowMs, lockMs: RATE.ipLockMs },
    { key: 'global', max: RATE.globalMaxFailures, windowMs: RATE.globalWindowMs, lockMs: RATE.globalLockMs },
  ];
}

/**
 * パスワード照合の前に試行を原子的に数える（読み取り→書き込みの競合で数え漏れない）。
 * 並行リクエストでも、ウィンドウ内で上限を超えた試行はパスワードを照合させない。戻り値は加算後の回数
 */
async function chargeAttempt(ctx: Ctx, l: Limit): Promise<number> {
  const now = ctx.now();
  const cutoff = new Date(now.getTime() - l.windowMs).toISOString();
  const r = await ctx.db.first<{ failures: number }>(
    `INSERT INTO login_attempts (key, failures, window_start, locked_until) VALUES (?, 1, ?, NULL)
     ON CONFLICT(key) DO UPDATE SET
       failures = CASE WHEN login_attempts.window_start <= ? THEN 1 ELSE login_attempts.failures + 1 END,
       window_start = CASE WHEN login_attempts.window_start <= ? THEN excluded.window_start ELSE login_attempts.window_start END
     RETURNING failures`,
    l.key,
    now.toISOString(),
    cutoff,
    cutoff,
  );
  return r?.failures ?? 1;
}

export function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? 'unknown';
}

export async function login(ctx: Ctx, body: LoginRequest, ip: string): Promise<LoginResponse> {
  if (!ctx.env.OWNER_PASSWORD) {
    throw new HttpError(503, 'internal', 'OWNER_PASSWORD is not configured on the server');
  }
  if (typeof body?.password !== 'string' || typeof body.deviceName !== 'string') {
    throw badRequest('password and deviceName are required');
  }
  const deviceName = body.deviceName.trim().slice(0, 100) || 'device';
  const limits = limitsFor(ip);
  await checkLocked(ctx, limits.map((l) => l.key));
  const counts: number[] = [];
  for (const l of limits) {
    const n = await chargeAttempt(ctx, l);
    if (n > l.max) throw new HttpError(429, 'rate_limited', 'too many login attempts', Math.ceil(l.lockMs / 1000));
    counts.push(n);
  }

  const ok = await timingSafeEqualStr(body.password, ctx.env.OWNER_PASSWORD);
  if (!ok) {
    const nowMs = ctx.now().getTime();
    const locks = limits
      .filter((l, i) => counts[i]! >= l.max)
      .map((l) =>
        stmt(
          `UPDATE login_attempts SET locked_until = ? WHERE key = ? AND (locked_until IS NULL OR locked_until < ?)`,
          new Date(nowMs + l.lockMs).toISOString(),
          l.key,
          new Date(nowMs).toISOString(),
        ),
      );
    await ctx.db.batch(locks);
    throw new HttpError(401, 'unauthorized', 'invalid password');
  }
  // 成功: この IP の記録を消し、全体の失敗回数からは先に数えた分を戻す
  await ctx.db.batch([
    stmt(`DELETE FROM login_attempts WHERE key = ?`, limits[0]!.key),
    stmt(`UPDATE login_attempts SET failures = failures - 1 WHERE key = ? AND failures > 0`, limits[1]!.key),
  ]);

  await purgeStaleDevices(ctx);
  const fp = await passwordFingerprint(ctx.env.OWNER_PASSWORD);
  const token = `cu_${randomToken(32)}`;
  const hash = await sha256Hex(token);
  const now = ctx.now().toISOString();
  let deviceId = typeof body.deviceId === 'string' && body.deviceId.length <= 100 ? body.deviceId : null;
  if (deviceId) {
    // 既存端末の再ログイン: 旧トークンを置き換える
    const r = await ctx.db.run(
      `UPDATE devices SET token_hash = ?, name = ?, last_seen_at = ?, pw_fp = ? WHERE id = ?`,
      hash,
      deviceName,
      now,
      fp,
      deviceId,
    );
    if (r.changes === 0) deviceId = null;
  }
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await ctx.db.run(
      `INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, pw_fp) VALUES (?, ?, ?, ?, ?, ?)`,
      deviceId,
      deviceName,
      hash,
      now,
      now,
      fp,
    );
  }
  return { token, deviceId };
}

export async function authenticate(ctx: Ctx, req: Request): Promise<DeviceRow> {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) throw new HttpError(401, 'unauthorized', 'missing bearer token');
  const hash = await sha256Hex(m[1]!);
  const dev = await ctx.db.first<DeviceRow>(`SELECT * FROM devices WHERE token_hash = ?`, hash);
  if (!dev) throw new HttpError(401, 'unauthorized', 'invalid or revoked token');
  if (ctx.env.OWNER_PASSWORD) {
    const fp = await passwordFingerprint(ctx.env.OWNER_PASSWORD);
    if (dev.pw_fp === null) {
      // 移行前にログインした端末: 現在のパスワードに結び付ける
      await ctx.db.run(`UPDATE devices SET pw_fp = ? WHERE id = ? AND pw_fp IS NULL`, fp, dev.id);
    } else if (dev.pw_fp !== fp) {
      await revokeDevice(ctx, dev.id);
      throw new HttpError(401, 'unauthorized', 'token revoked by password change');
    }
  }
  const now = ctx.now();
  if (now.getTime() - Date.parse(dev.last_seen_at) > LAST_SEEN_THROTTLE_MS) {
    await ctx.db.run(`UPDATE devices SET last_seen_at = ? WHERE id = ?`, now.toISOString(), dev.id);
  }
  return dev;
}

export async function revokeDevice(ctx: Ctx, deviceId: string): Promise<boolean> {
  const rs = await ctx.db.batch([
    stmt(`DELETE FROM push_subscriptions WHERE device_id = ?`, deviceId),
    stmt(`DELETE FROM devices WHERE id = ?`, deviceId),
  ]);
  return (rs[1]?.changes ?? 0) > 0;
}

export async function listDevices(ctx: Ctx, currentId: string) {
  const rows = await ctx.db.all<DeviceRow>(`SELECT * FROM devices ORDER BY created_at`);
  return {
    devices: rows.map((d) => ({
      deviceId: d.id,
      deviceName: d.name,
      createdAt: d.created_at,
      lastSeenAt: d.last_seen_at,
      current: d.id === currentId,
    })),
  };
}
