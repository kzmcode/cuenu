import { API_VERSION } from '@cuenu/core';
import { describe, expect, it, vi } from 'vitest';
import { checkHealth, connect, envKeyFor, loadActiveConnection, login, normalizeServerUrl, planSwitch, type FetchFn } from './connection';
import { createBrowserDevBridge, type EnvConfig } from './native';

const health = { name: 'cuenu', apiVersion: API_VERSION, minClientApiVersion: API_VERSION, serverTime: '2026-11-04T00:00:00.000Z' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

function fakeServer(opts: { health?: unknown; healthStatus?: number; password?: string; loginStatus?: number } = {}) {
  const calls: { url: string; body?: unknown }[] = [];
  const fetchFn: FetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/api/health')) return json(opts.healthStatus ?? 200, opts.health ?? health);
    if (url.endsWith('/api/auth/login')) {
      const body = JSON.parse(String(init?.body)) as { password: string; deviceId?: string };
      if (opts.loginStatus === 429) return json(429, { error: { code: 'rate_limited', message: 'slow', retryAfterSec: 30 } });
      if (body.password !== (opts.password ?? 'pw')) return json(401, { error: { code: 'unauthorized', message: 'no' } });
      return json(200, { token: 'tok-1', deviceId: body.deviceId ?? 'dev-new' });
    }
    return json(404, {});
  });
  return { fetchFn, calls };
}

describe('normalizeServerUrl', () => {
  it('スキーム補完・origin 化', () => {
    expect(normalizeServerUrl(' cuenu.example.workers.dev/ ')).toEqual({ ok: true, origin: 'https://cuenu.example.workers.dev' });
    expect(normalizeServerUrl('https://Cuenu.Example.dev/app?x=1')).toEqual({ ok: true, origin: 'https://cuenu.example.dev' });
    expect(normalizeServerUrl('http://localhost:8787', true)).toEqual({ ok: true, origin: 'http://localhost:8787' });
    expect(normalizeServerUrl('http://localhost:8787', false).ok).toBe(false);
  });
  it('http（ローカル以外）・空・不正を拒否', () => {
    expect(normalizeServerUrl('http://example.com').ok).toBe(false);
    expect(normalizeServerUrl('').ok).toBe(false);
    expect(normalizeServerUrl('https://u:p@example.com').ok).toBe(false);
    expect(normalizeServerUrl('ht tp://x').ok).toBe(false);
  });
});

describe('envKeyFor', () => {
  it('決定的で、Keychain/DB 名に使える文字だけ', () => {
    const a = envKeyFor('https://a.example');
    expect(a).toBe(envKeyFor('https://A.example'));
    expect(a).not.toBe(envKeyFor('https://b.example'));
    expect(a).toMatch(/^env-[0-9a-f]{8}$/);
  });
});

describe('checkHealth', () => {
  it('互換サーバーを受け入れる', async () => {
    const { fetchFn } = fakeServer();
    expect(await checkHealth('https://s', fetchFn)).toMatchObject({ ok: true });
  });
  it('Cuenu 以外・古いサーバー・古いクライアント・通信失敗を区別する', async () => {
    expect(await checkHealth('https://s', fakeServer({ health: { hello: 1 } }).fetchFn)).toMatchObject({ reason: 'not_cuenu' });
    expect(await checkHealth('https://s', fakeServer({ health: { ...health, apiVersion: API_VERSION - 1 } }).fetchFn)).toMatchObject({ reason: 'server_too_old' });
    expect(await checkHealth('https://s', fakeServer({ health: { ...health, minClientApiVersion: API_VERSION + 1 } }).fetchFn)).toMatchObject({
      reason: 'client_too_old',
    });
    expect(await checkHealth('https://s', fakeServer({ healthStatus: 500 }).fetchFn)).toMatchObject({ reason: 'http' });
    expect(await checkHealth('https://s', async () => Promise.reject(new TypeError('fail')))).toMatchObject({ reason: 'network' });
  });
});

describe('login', () => {
  it('401 / 429 を利用者向けメッセージにする', async () => {
    expect(await login('https://s', 'bad', fakeServer().fetchFn)).toMatchObject({ ok: false, reason: 'unauthorized' });
    const r = await login('https://s', 'pw', fakeServer({ loginStatus: 429 }).fetchFn);
    expect(r).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(!r.ok && r.message).toContain('30 秒');
  });
});

describe('connect', () => {
  it('health → login → Keychain → 接続先確定 の順に行う', async () => {
    const bridge = createBrowserDevBridge(memoryStorage());
    const { fetchFn, calls } = fakeServer();
    const steps: string[] = [];
    const r = await connect('cuenu.example.dev', 'pw', { fetch: fetchFn, bridge, onStep: (s) => steps.push(s) });
    expect(r.ok).toBe(true);
    expect(steps).toEqual(['validating', 'health', 'login', 'saving']);
    expect(calls.map((c) => c.url)).toEqual(['https://cuenu.example.dev/api/health', 'https://cuenu.example.dev/api/auth/login']);
    expect(calls[1]!.body).toEqual({ password: 'pw', deviceName: 'Mac' });
    const envKey = envKeyFor('https://cuenu.example.dev');
    expect(await bridge.getToken(envKey)).toBe('tok-1');
    expect((await bridge.getSettings()).active).toEqual({ serverUrl: 'https://cuenu.example.dev', envKey, deviceId: 'dev-new' });
    expect(await loadActiveConnection(bridge)).toEqual({
      state: 'ready',
      env: { serverUrl: 'https://cuenu.example.dev', envKey, deviceId: 'dev-new' },
      config: { serverUrl: 'https://cuenu.example.dev', token: 'tok-1', deviceId: 'dev-new' },
    });
  });

  it('同じサーバーへの再ログインでは既存 deviceId を送る', async () => {
    const bridge = createBrowserDevBridge(memoryStorage());
    const origin = 'https://cuenu.example.dev';
    await bridge.setActiveConnection({ serverUrl: origin, envKey: envKeyFor(origin), deviceId: 'dev-old' });
    const { fetchFn, calls } = fakeServer();
    const r = await connect(origin, 'pw', { fetch: fetchFn, bridge });
    expect(r).toMatchObject({ ok: true, env: { deviceId: 'dev-old' } });
    expect(calls[1]!.body).toMatchObject({ deviceId: 'dev-old' });
  });

  it('失敗時は接続先を変更しない', async () => {
    const bridge = createBrowserDevBridge(memoryStorage());
    const r = await connect('https://cuenu.example.dev', 'wrong', { fetch: fakeServer().fetchFn, bridge });
    expect(r).toMatchObject({ ok: false, step: 'login' });
    expect((await bridge.getSettings()).active).toBeNull();
  });

  it('Keychain 保存に失敗したら接続先を切り替えない', async () => {
    const bridge = createBrowserDevBridge(memoryStorage());
    bridge.setToken = async () => {
      throw new Error('keychain locked');
    };
    const r = await connect('https://cuenu.example.dev', 'pw', { fetch: fakeServer().fetchFn, bridge });
    expect(r).toMatchObject({ ok: false, step: 'saving' });
    expect((await bridge.getSettings()).active).toBeNull();
  });

  it('トークンが無ければ needs-login（ローカルデータは使える）', async () => {
    const bridge = createBrowserDevBridge(memoryStorage());
    const env: EnvConfig = { serverUrl: 'https://x', envKey: envKeyFor('https://x'), deviceId: 'd' };
    await bridge.setActiveConnection(env);
    expect(await loadActiveConnection(bridge)).toEqual({ state: 'needs-login', env });
  });
});

describe('planSwitch', () => {
  const cur: EnvConfig = { serverUrl: 'https://a.example', envKey: envKeyFor('https://a.example'), deviceId: 'd' };
  it('初回 / 同一環境 / 切替（未送信あり・なし）', () => {
    expect(planSwitch(null, 'https://a.example', 0)).toEqual({ kind: 'first' });
    expect(planSwitch(cur, 'https://a.example', 5)).toEqual({ kind: 'same-env' });
    expect(planSwitch(cur, 'https://b.example', 0)).toEqual({ kind: 'switch', pendingOps: 0, message: null });
    const p = planSwitch(cur, 'https://b.example', 3);
    expect(p.kind === 'switch' && p.message).toContain('3 件');
  });
});
