// 初回接続フロー: サーバーURL入力 → /api/health で接続・互換性確認 → /api/auth/login → Keychain 保存 → 接続先確定。
// 接続先（サーバー origin）ごとに envKey を決め、ローカル DB と Keychain 項目を分離する。

import { API_VERSION } from '@cuenu/core';
import type { ApiError, ConnectionConfig, HealthResponse, LoginRequest, LoginResponse } from '@cuenu/core';
import type { EnvConfig, NativeBridge } from './native';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const DEVICE_NAME = 'Mac';
const UPDATE_APP_HINT = 'Mac アプリを更新してください（brew update && brew upgrade --cask cuenu）。';
const UPDATE_SERVER_HINT = 'サーバーを最新版で再デプロイしてください（README の更新手順）。';

// ---------- URL / envKey ----------

export type UrlCheck = { ok: true; origin: string } | { ok: false; error: string };

/**
 * 入力を origin に正規化する。https のみ許可（開発ビルドに限り localhost / 127.0.0.1 の http も可。
 * 配布版の CSP は http を許可しない）。
 * Cuenu サーバーは origin 直下（/api/...）で動く前提なのでパスは捨てる。
 */
export function normalizeServerUrl(input: string, allowLocalHttp: boolean = import.meta.env.DEV): UrlCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'サーバーURLを入力してください' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: 'URLの形式が正しくありません' };
  }
  const local = allowLocalHttp && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return { ok: false, error: 'https:// のURLを指定してください（http はローカル開発時のみ）' };
  }
  if (url.username || url.password) return { ok: false, error: 'URLに認証情報を含めないでください' };
  return { ok: true, origin: url.origin };
}

/** origin から決定的に作る短いキー（DB 名・Keychain アカウント名に使う。英数字とハイフンのみ） */
export function envKeyFor(origin: string): string {
  let h = 0x811c9dc5;
  for (const ch of new TextEncoder().encode(origin.toLowerCase())) {
    h ^= ch;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `env-${h.toString(16).padStart(8, '0')}`;
}

// ---------- health ----------

export type HealthCheck =
  | { ok: true; health: HealthResponse }
  | { ok: false; reason: 'network' | 'not_cuenu' | 'client_too_old' | 'server_too_old' | 'http'; message: string };

async function fetchWithTimeout(fetchFn: FetchFn, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function checkCompatibility(h: HealthResponse, clientApiVersion = API_VERSION): HealthCheck {
  if (h.minClientApiVersion > clientApiVersion) {
    return {
      ok: false,
      reason: 'client_too_old',
      message: `この Mac アプリ（API v${clientApiVersion}）はサーバー（v${h.minClientApiVersion} 以上が必要）と互換性がありません。${UPDATE_APP_HINT}`,
    };
  }
  if (h.apiVersion < clientApiVersion) {
    return {
      ok: false,
      reason: 'server_too_old',
      message: `サーバー（API v${h.apiVersion}）が古いため、この Mac アプリ（v${clientApiVersion}）と接続できません。${UPDATE_SERVER_HINT}`,
    };
  }
  return { ok: true, health: h };
}

export async function checkHealth(origin: string, fetchFn: FetchFn, timeoutMs = 10000): Promise<HealthCheck> {
  let res: Response;
  try {
    res = await fetchWithTimeout(fetchFn, `${origin}/api/health`, { method: 'GET' }, timeoutMs);
  } catch {
    return {
      ok: false,
      reason: 'network',
      message: 'サーバーに接続できません。URL・ネットワーク・サーバーのデプロイ状況を確認してください。',
    };
  }
  if (!res.ok) {
    return { ok: false, reason: 'http', message: `接続確認に失敗しました（HTTP ${res.status}）。Cuenu サーバーのURLか確認してください。` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'not_cuenu', message: 'Cuenu サーバーの応答ではありません。URLを確認してください。' };
  }
  const h = body as Partial<HealthResponse>;
  if (h?.name !== 'cuenu' || typeof h.apiVersion !== 'number' || typeof h.minClientApiVersion !== 'number') {
    return { ok: false, reason: 'not_cuenu', message: 'Cuenu サーバーの応答ではありません。URLを確認してください。' };
  }
  return checkCompatibility(h as HealthResponse);
}

// ---------- login ----------

export type LoginResult =
  | { ok: true; token: string; deviceId: string }
  | { ok: false; reason: 'unauthorized' | 'rate_limited' | 'incompatible' | 'network' | 'http'; message: string };

export async function login(
  origin: string,
  password: string,
  fetchFn: FetchFn,
  deviceId?: string,
  timeoutMs = 15000,
): Promise<LoginResult> {
  const req: LoginRequest = { password, deviceName: DEVICE_NAME, ...(deviceId ? { deviceId } : {}) };
  let res: Response;
  try {
    res = await fetchWithTimeout(
      fetchFn,
      `${origin}/api/auth/login`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) },
      timeoutMs,
    );
  } catch {
    return { ok: false, reason: 'network', message: 'ログイン中に通信できませんでした。' };
  }
  const json = (await res.json().catch(() => null)) as (LoginResponse & Partial<ApiError>) | null;
  if (res.ok && json && typeof json.token === 'string' && typeof json.deviceId === 'string') {
    return { ok: true, token: json.token, deviceId: json.deviceId };
  }
  const code = json?.error?.code;
  if (res.status === 401 || code === 'unauthorized') {
    return { ok: false, reason: 'unauthorized', message: 'パスワードが違います（サーバーの OWNER_PASSWORD）。' };
  }
  if (res.status === 429 || code === 'rate_limited') {
    const sec = json?.error?.retryAfterSec;
    return { ok: false, reason: 'rate_limited', message: `試行回数が多すぎます。${sec ? `${sec} 秒` : 'しばらく'}待ってから再試行してください。` };
  }
  if (code === 'incompatible_client') {
    return { ok: false, reason: 'incompatible', message: json?.error?.message ?? UPDATE_APP_HINT };
  }
  return { ok: false, reason: 'http', message: `ログインに失敗しました（HTTP ${res.status}）。` };
}

// ---------- 接続先切替の計画 ----------

export type SwitchPlan =
  | { kind: 'first' }
  | { kind: 'same-env' }
  | { kind: 'switch'; pendingOps: number; message: string | null };

/**
 * 接続先を変える前に、扱いを決める。
 * - 同じ origin: 再ログインのみ（ローカルデータ・未送信はそのまま）。
 * - 別の origin: 新しい環境用の別ローカル DB を使う。前環境のデータと未送信操作は前環境の DB に残り、
 *   新しい環境へは送信しない。前環境に戻せば再送される。未送信がある場合は確認を求める。
 */
export function planSwitch(current: EnvConfig | null, nextOrigin: string, pendingOps: number): SwitchPlan {
  if (!current) return { kind: 'first' };
  if (current.envKey === envKeyFor(nextOrigin)) return { kind: 'same-env' };
  const message =
    pendingOps > 0
      ? `現在の接続先（${current.serverUrl}）に未送信の変更が ${pendingOps} 件あります。` +
        '切り替えても削除はされず、この Mac の旧環境用データに残りますが、新しい接続先には送信されません。' +
        '旧環境に戻すと再送されます。必要なら先にエクスポートしてください。'
      : null;
  return { kind: 'switch', pendingOps, message };
}

// ---------- 接続実行 ----------

export type ConnectStep = 'validating' | 'health' | 'login' | 'saving';

export interface ConnectDeps {
  fetch: FetchFn;
  bridge: Pick<NativeBridge, 'getSettings' | 'setToken' | 'setActiveConnection'>;
  onStep?: (s: ConnectStep) => void;
}

export type ConnectResult = { ok: true; env: EnvConfig; health: HealthResponse } | { ok: false; step: ConnectStep; message: string };

export async function connect(serverUrl: string, password: string, deps: ConnectDeps): Promise<ConnectResult> {
  deps.onStep?.('validating');
  const u = normalizeServerUrl(serverUrl);
  if (!u.ok) return { ok: false, step: 'validating', message: u.error };
  if (!password) return { ok: false, step: 'validating', message: 'パスワードを入力してください' };

  deps.onStep?.('health');
  const h = await checkHealth(u.origin, deps.fetch);
  if (!h.ok) return { ok: false, step: 'health', message: h.message };

  deps.onStep?.('login');
  const envKey = envKeyFor(u.origin);
  const settings = await deps.bridge.getSettings();
  const knownDeviceId = settings.known.find((k) => k.envKey === envKey)?.deviceId;
  const l = await login(u.origin, password, deps.fetch, knownDeviceId);
  if (!l.ok) return { ok: false, step: 'login', message: l.message };

  deps.onStep?.('saving');
  const env: EnvConfig = { serverUrl: u.origin, envKey, deviceId: l.deviceId };
  try {
    // Keychain 保存に成功してから接続先を切り替える（失敗時は旧接続のまま）
    await deps.bridge.setToken(envKey, l.token);
    await deps.bridge.setActiveConnection(env);
  } catch (e) {
    return { ok: false, step: 'saving', message: `ログイン情報を Keychain に保存できませんでした: ${String(e)}` };
  }
  return { ok: true, env, health: h.health };
}

// ---------- 起動時の読み込み ----------

export type ActiveConnection =
  | { state: 'none' }
  | { state: 'needs-login'; env: EnvConfig }
  | { state: 'ready'; env: EnvConfig; config: ConnectionConfig };

/** 端末トークンを Keychain から取得する（同期開始時にだけ呼ぶ）。トークンが無くてもローカルデータは使える。 */
export async function loadActiveConnection(bridge: Pick<NativeBridge, 'getSettings' | 'getToken'>): Promise<ActiveConnection> {
  const s = await bridge.getSettings();
  if (!s.active) return { state: 'none' };
  let token: string | null = null;
  try {
    token = await bridge.getToken(s.active.envKey);
  } catch {
    token = null;
  }
  if (!token) return { state: 'needs-login', env: s.active };
  return { state: 'ready', env: s.active, config: { serverUrl: s.active.serverUrl, token, deviceId: s.active.deviceId } };
}

/**
 * ログアウト: サーバーのトークンを失効（失敗しても続行）→ Keychain から削除。
 * 接続先設定とローカルデータは残す（再ログインで同じ環境に戻れる）。
 */
export async function logout(
  env: EnvConfig,
  bridge: Pick<NativeBridge, 'getToken' | 'deleteToken'>,
  fetchFn: FetchFn,
): Promise<void> {
  const token = await bridge.getToken(env.envKey).catch(() => null);
  if (token) {
    await fetchFn(`${env.serverUrl}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
  }
  await bridge.deleteToken(env.envKey);
}
