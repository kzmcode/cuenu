import type { Ctx } from '../context';
import { stmt } from '../db';
import { badRequest } from '../http';
import { getSettings } from '../settings';
import { b64urlDecode, truncate } from '../util';
import { buildPushRequest, type VapidKeys } from './webpush';

export const DEFAULT_NOTIFICATION_BODY = '新しいAIの提案があります';

export function vapidKeys(ctx: Ctx): VapidKeys | null {
  const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv, VAPID_SUBJECT: sub } = ctx.env;
  return pub && priv && sub ? { publicKey: pub, privateKey: priv, subject: sub } : null;
}

interface SubRow {
  endpoint: string;
  device_id: string | null;
  p256dh: string;
  auth: string;
}

export async function saveSubscription(ctx: Ctx, deviceId: string, body: unknown): Promise<void> {
  const b = body as { deviceId?: unknown; subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } };
  const s = b?.subscription;
  const endpoint = s?.endpoint;
  const p256dh = s?.keys?.p256dh;
  const auth = s?.keys?.auth;
  if (typeof endpoint !== 'string' || endpoint.length > 2000 || !isHttpsUrl(endpoint)) throw badRequest('invalid endpoint');
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !validKeys(p256dh, auth)) {
    throw badRequest('invalid subscription keys');
  }
  await ctx.db.run(
    `INSERT INTO push_subscriptions (endpoint, device_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth,
       last_error = NULL`,
    endpoint,
    deviceId,
    p256dh,
    auth,
    ctx.now().toISOString(),
  );
}

function isHttpsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** 送信時に失敗し続けないよう、保存前に鍵の形式（P-256 非圧縮 65B / auth 16B）を確認する */
function validKeys(p256dh: string, auth: string): boolean {
  if (p256dh.length > 200 || auth.length > 100) return false;
  try {
    const pub = b64urlDecode(p256dh);
    return pub.length === 65 && pub[0] === 4 && b64urlDecode(auth).length === 16;
  } catch {
    return false;
  }
}

export async function deleteSubscription(ctx: Ctx, body: unknown): Promise<void> {
  const endpoint = (body as { endpoint?: unknown })?.endpoint;
  if (typeof endpoint !== 'string') throw badRequest('endpoint required');
  await ctx.db.run(`DELETE FROM push_subscriptions WHERE endpoint = ?`, endpoint);
}

/**
 * 未通知の AI 投稿を通知する。投稿保存後に呼ぶ。
 * - ai_posts.notified を条件付き UPDATE で取って（多重実行でも 1 回だけ）送る
 * - (memo, endpoint) 単位の push_deliveries で重複送信を防ぐ
 * - 404/410 の購読は削除。通知失敗で投稿は消さない
 */
export async function notifyPendingPosts(ctx: Ctx, maxPosts = 3): Promise<number> {
  const keys = vapidKeys(ctx);
  const db = ctx.db;
  const since = new Date(ctx.now().getTime() - 24 * 3600_000).toISOString();
  const posts = await db.all<{ job_id: string; memo_id: string }>(
    `SELECT job_id, memo_id FROM ai_posts WHERE notified = 0 AND created_at >= ? ORDER BY created_at LIMIT ?`,
    since,
    maxPosts,
  );
  if (posts.length === 0) return 0;
  if (!keys) {
    // 通知未設定なら送らずに済んだ扱い
    await db.batch(posts.map((p) => stmt(`UPDATE ai_posts SET notified = 1 WHERE job_id = ?`, p.job_id)));
    return 0;
  }
  const settings = await getSettings(db);
  const subs = await db.all<SubRow>(`SELECT * FROM push_subscriptions`);
  let sent = 0;
  const expired = new Set<string>();
  for (const p of posts) {
    const claim = await db.run(`UPDATE ai_posts SET notified = 1 WHERE job_id = ? AND notified = 0`, p.job_id);
    if (claim.changes === 0) continue;
    const memo = await db.first<{ body: string; deleted_at: string | null }>(
      `SELECT body, deleted_at FROM memos WHERE id = ?`,
      p.memo_id,
    );
    if (!memo || memo.deleted_at) continue;
    const payload = {
      title: 'Cuenu',
      body: settings.notificationDetail ? truncate(memo.body.replace(/\s+/g, ' '), 80) : DEFAULT_NOTIFICATION_BODY,
      memoId: p.memo_id,
      url: `/?memo=${p.memo_id}`,
    };
    for (const s of subs) {
      if (expired.has(s.endpoint)) continue;
      const nowIso = ctx.now().toISOString();
      const mark = await db.run(
        `INSERT OR IGNORE INTO push_deliveries (memo_id, endpoint, status, sent_at) VALUES (?, ?, 'sending', ?)`,
        p.memo_id,
        s.endpoint,
        nowIso,
      );
      if (mark.changes === 0) continue;
      let status = 'failed';
      try {
        const req = await buildPushRequest(s, payload, keys, ctx.now());
        const res = await ctx.fetch(req.url, req.init);
        if (res.status === 404 || res.status === 410) {
          await db.run(`DELETE FROM push_subscriptions WHERE endpoint = ?`, s.endpoint);
          expired.add(s.endpoint);
          status = 'expired';
        } else if (res.ok) {
          status = 'sent';
          sent++;
        } else {
          status = `http_${res.status}`;
          await db.run(`UPDATE push_subscriptions SET last_error = ? WHERE endpoint = ?`, status, s.endpoint);
        }
      } catch (e) {
        status = 'error';
        await db.run(
          `UPDATE push_subscriptions SET last_error = ? WHERE endpoint = ?`,
          String((e as Error).message).slice(0, 200),
          s.endpoint,
        );
      }
      await db.run(`UPDATE push_deliveries SET status = ? WHERE memo_id = ? AND endpoint = ?`, status, p.memo_id, s.endpoint);
    }
  }
  return sent;
}
