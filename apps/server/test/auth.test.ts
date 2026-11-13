import { describe, expect, test } from 'vitest';
import { handleApi } from '../src/app';
import { makeCtx, req } from './helpers';

async function login(ctx: ReturnType<typeof makeCtx>, password = 'secret-pw', extra: object = {}, ip = '1.1.1.1') {
  return handleApi(
    ctx,
    req('/api/auth/login', { method: 'POST', json: { password, deviceName: 'test', ...extra }, headers: { 'cf-connecting-ip': ip } }),
  );
}

describe('auth', () => {
  test('health is public', async () => {
    const ctx = makeCtx();
    const r = await handleApi(ctx, req('/api/health'));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ name: 'cuenu', apiVersion: 1 });
  });

  test('protected endpoints require token', async () => {
    const ctx = makeCtx();
    for (const p of ['/api/sync/pull', '/api/settings', '/api/export', '/api/devices', '/api/ai/status']) {
      const r = await handleApi(ctx, req(p));
      expect(r.status, p).toBe(401);
      expect(await r.json()).toMatchObject({ error: { code: 'unauthorized' } });
    }
    const r = await handleApi(ctx, req('/api/settings', { token: 'cu_bogus' }));
    expect(r.status).toBe(401);
  });

  test('login issues token, stores only hash, logout revokes', async () => {
    const ctx = makeCtx();
    const r = await login(ctx);
    expect(r.status).toBe(200);
    const { token, deviceId } = (await r.json()) as { token: string; deviceId: string };
    const row = ctx.db.raw.prepare('SELECT token_hash FROM devices WHERE id = ?').get(deviceId) as { token_hash: string };
    expect(row.token_hash).not.toContain(token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const s = await handleApi(ctx, req('/api/settings', { token }));
    expect(s.status).toBe(200);
    const devs = (await (await handleApi(ctx, req('/api/devices', { token }))).json()) as { devices: { current: boolean }[] };
    expect(devs.devices).toHaveLength(1);
    expect(devs.devices[0]!.current).toBe(true);

    expect((await handleApi(ctx, req('/api/auth/logout', { method: 'POST', token }))).status).toBe(204);
    expect((await handleApi(ctx, req('/api/settings', { token }))).status).toBe(401);
  });

  test('relogin with deviceId replaces old token', async () => {
    const ctx = makeCtx();
    const a = (await (await login(ctx)).json()) as { token: string; deviceId: string };
    const b = (await (await login(ctx, 'secret-pw', { deviceId: a.deviceId })).json()) as { token: string; deviceId: string };
    expect(b.deviceId).toBe(a.deviceId);
    expect((await handleApi(ctx, req('/api/settings', { token: a.token }))).status).toBe(401);
    expect((await handleApi(ctx, req('/api/settings', { token: b.token }))).status).toBe(200);
  });

  test('device revoke via DELETE /api/devices/:id', async () => {
    const ctx = makeCtx();
    const a = (await (await login(ctx)).json()) as { token: string; deviceId: string };
    const b = (await (await login(ctx)).json()) as { token: string; deviceId: string };
    const r = await handleApi(ctx, req(`/api/devices/${b.deviceId}`, { method: 'DELETE', token: a.token }));
    expect(r.status).toBe(204);
    expect((await handleApi(ctx, req('/api/settings', { token: b.token }))).status).toBe(401);
  });

  test('failed logins are rate limited per IP', async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 5; i++) expect((await login(ctx, 'wrong')).status).toBe(401);
    const r = await login(ctx); // 正しいパスワードでもロック中
    expect(r.status).toBe(429);
    const body = (await r.json()) as { error: { code: string; retryAfterSec: number } };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.retryAfterSec).toBeGreaterThan(0);
    expect(r.headers.get('retry-after')).toBeTruthy();
    // 別 IP は通る
    expect((await login(ctx, 'secret-pw', {}, '2.2.2.2')).status).toBe(200);
    // ロック解除後は通る
    ctx.clock.t += 16 * 60_000;
    expect((await login(ctx)).status).toBe(200);
  });

  test('global limit across IPs', async () => {
    const ctx = makeCtx();
    // 既存端末を 1 台登録しておく
    const { deviceId } = (await (await login(ctx, 'secret-pw', {}, '8.8.8.8')).json()) as { deviceId: string };
    for (let i = 0; i < 50; i++) await login(ctx, 'wrong', {}, `10.0.${Math.floor(i / 4)}.${i}`);
    // 新しい端末は全体の上限で止まる
    expect((await login(ctx, 'secret-pw', {}, '9.9.9.9')).status).toBe(429);
    // 登録済みの端末は全体の上限の対象外（IP ごとの上限は残る）
    expect((await login(ctx, 'secret-pw', { deviceId }, '9.9.9.9')).status).toBe(200);
    // 長時間ロックはせず、ウィンドウが過ぎれば回復する
    ctx.clock.t += 61 * 60_000;
    expect((await login(ctx, 'secret-pw', {}, '9.9.9.7')).status).toBe(200);
  });

  test('unknown device ids do not bypass the global limit', async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 50; i++) await login(ctx, 'wrong', { deviceId: 'guess' }, `10.0.${Math.floor(i / 4)}.${i}`);
    expect((await login(ctx, 'secret-pw', { deviceId: 'guess' }, '9.9.9.9')).status).toBe(429);
  });

  test('IPv6 addresses are limited per /64', async () => {
    const ctx = makeCtx();
    for (let i = 1; i <= 5; i++) expect((await login(ctx, 'wrong', {}, `2001:db8:1:2::${i}`)).status).toBe(401);
    expect((await login(ctx, 'secret-pw', {}, '2001:0db8:0001:0002:ffff::1')).status).toBe(429);
    expect((await login(ctx, 'secret-pw', {}, '2001:db8:1:3::1')).status).toBe(200);
  });

  test('login without OWNER_PASSWORD configured fails closed', async () => {
    const ctx = makeCtx({ env: { OWNER_PASSWORD: undefined } });
    expect((await login(ctx, '')).status).toBe(503);
  });

  test('CORS allows tauri and same origin only', async () => {
    const ctx = makeCtx();
    for (const o of ['tauri://localhost', 'http://tauri.localhost', 'https://cuenu.example.com']) {
      const r = await handleApi(ctx, req('/api/health', { headers: { origin: o } }));
      expect(r.headers.get('access-control-allow-origin')).toBe(o);
      const p = await handleApi(ctx, req('/api/sync/pull', { method: 'OPTIONS', headers: { origin: o } }));
      expect(p.status).toBe(204);
      expect(p.headers.get('access-control-allow-headers')).toContain('Authorization');
    }
    const bad = await handleApi(ctx, req('/api/health', { headers: { origin: 'https://evil.example' } }));
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const pf = await handleApi(ctx, req('/api/health', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
    expect(pf.status).toBe(403);
  });

  test('concurrent wrong passwords cannot exceed the per-IP limit', async () => {
    const ctx = makeCtx();
    const rs = await Promise.all(Array.from({ length: 20 }, () => login(ctx, 'wrong')));
    const statuses = rs.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);
    expect((await login(ctx)).status).toBe(429);
  });

  test('successful logins do not count toward the global limit', async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 49; i++) await login(ctx, 'wrong', {}, `10.0.${Math.floor(i / 4)}.${i}`);
    for (let i = 0; i < 5; i++) expect((await login(ctx, 'secret-pw', {}, '9.9.9.9')).status).toBe(200);
    expect((await login(ctx, 'secret-pw', {}, '9.9.9.8')).status).toBe(200);
  });

  test('malformed device id is 404, API responses are nosniff', async () => {
    const ctx = makeCtx();
    const { token } = (await (await login(ctx)).json()) as { token: string };
    const r = await handleApi(ctx, req('/api/devices/%E0%A4%A', { method: 'DELETE', token }));
    expect(r.status).toBe(404);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('password change revokes tokens issued under the old password', async () => {
    const ctx = makeCtx();
    const { token, deviceId } = (await (await login(ctx)).json()) as { token: string; deviceId: string };
    expect((await handleApi(ctx, req('/api/settings', { token }))).status).toBe(200);

    ctx.env.OWNER_PASSWORD = 'new-secret-pw';
    const r = await handleApi(ctx, req('/api/settings', { token }));
    expect(r.status).toBe(401);
    expect(ctx.db.raw.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId)).toBeUndefined();

    expect((await login(ctx, 'secret-pw')).status).toBe(401);
    const fresh = (await (await login(ctx, 'new-secret-pw', {}, '2.2.2.2')).json()) as { token: string };
    expect((await handleApi(ctx, req('/api/settings', { token: fresh.token }))).status).toBe(200);
  });

  test('login after password change purges stale devices and their push subscriptions', async () => {
    const ctx = makeCtx();
    const { deviceId } = (await (await login(ctx)).json()) as { deviceId: string };
    ctx.db.raw
      .prepare('INSERT INTO push_subscriptions (endpoint, device_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('https://push.example/x', deviceId, 'k', 'a', '2026-11-04T00:00:00.000Z');
    ctx.env.OWNER_PASSWORD = 'new-secret-pw';
    expect((await login(ctx, 'new-secret-pw', {}, '2.2.2.2')).status).toBe(200);
    expect(ctx.db.raw.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId)).toBeUndefined();
    expect(ctx.db.raw.prepare('SELECT endpoint FROM push_subscriptions').all()).toHaveLength(0);
  });

  test('devices from before the migration are bound on first use', async () => {
    const ctx = makeCtx();
    const { token, deviceId } = (await (await login(ctx)).json()) as { token: string; deviceId: string };
    ctx.db.raw.prepare('UPDATE devices SET pw_fp = NULL').run();
    expect((await handleApi(ctx, req('/api/settings', { token }))).status).toBe(200);
    const row = ctx.db.raw.prepare('SELECT pw_fp FROM devices WHERE id = ?').get(deviceId) as { pw_fp: string | null };
    expect(row.pw_fp).toMatch(/^[0-9a-f]{64}$/);
    ctx.env.OWNER_PASSWORD = 'new-secret-pw';
    expect((await handleApi(ctx, req('/api/settings', { token }))).status).toBe(401);
  });
});
