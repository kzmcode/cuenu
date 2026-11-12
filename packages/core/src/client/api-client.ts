// サーバー API の型付きラッパー。エラーは ApiRequestError に正規化する。

import type {
  AiStatusResponse,
  ApiErrorCode,
  ExportBundle,
  HealthResponse,
  ImageSummarizeRequest,
  ImageSummarizeResponse,
  LoginRequest,
  LoginResponse,
  PullResponse,
  PushRequest,
  PushResponse,
  SemanticSearchRequest,
  SemanticSearchResponse,
  SettingsResponse,
} from '../api';
import type { IsoDate, UserSettings } from '../types';
import { normalizeServerUrl } from './util';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 'network' は通信失敗（オフライン・DNS・CORS 等）、'bad_response' は JSON 以外の応答 */
export type ClientErrorCode = ApiErrorCode | 'network' | 'bad_response';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly retryAfterSec: number | null;
  constructor(status: number, code: ClientErrorCode, message: string, retryAfterSec: number | null = null) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
  get isAuthError() {
    return this.status === 401 || this.code === 'unauthorized';
  }
  /** 時間をおけば成功しうる */
  get isTransient() {
    return this.code === 'network' || this.status === 429 || this.status >= 500;
  }
}

export const isApiRequestError = (e: unknown): e is ApiRequestError => e instanceof ApiRequestError;

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  createdAt: IsoDate;
  lastSeenAt: IsoDate;
  current: boolean;
}

export interface ApiClient {
  readonly serverUrl: string;
  health(): Promise<HealthResponse>;
  login(req: LoginRequest): Promise<LoginResponse>;
  logout(): Promise<void>;
  devices(): Promise<{ devices: DeviceInfo[] }>;
  deleteDevice(deviceId: string): Promise<void>;
  push(req: PushRequest): Promise<PushResponse>;
  pull(since: number, limit?: number): Promise<PullResponse>;
  summarizeImage(req: ImageSummarizeRequest): Promise<ImageSummarizeResponse>;
  semanticSearch(req: SemanticSearchRequest): Promise<SemanticSearchResponse>;
  getSettings(): Promise<SettingsResponse>;
  putSettings(patch: Partial<UserSettings>): Promise<SettingsResponse>;
  aiStatus(): Promise<AiStatusResponse>;
  vapidPublicKey(): Promise<{ publicKey: string }>;
  subscribePush(deviceId: string, subscription: PushSubscriptionJSON): Promise<void>;
  unsubscribePush(endpoint: string): Promise<void>;
  exportAll(): Promise<ExportBundle>;
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

const validSec = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return validSec(n);
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, Math.ceil((d - Date.now()) / 1000)) : null;
}

/**
 * @param serverUrl 例 https://cuenu.example.workers.dev。PWA（同一オリジン）は '' または location.origin
 * @param token 端末トークン。login 前は null
 */
export function createApiClient(serverUrl: string, token: string | null, fetchImpl: FetchLike = defaultFetch): ApiClient {
  const base = serverUrl ? normalizeServerUrl(serverUrl) : '';

  async function request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiRequestError(0, 'network', e instanceof Error ? e.message : String(e));
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text().catch(() => '');
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const raw = (json as { error?: { code?: unknown; message?: unknown; retryAfterSec?: unknown } } | null)?.error;
      const err = raw && typeof raw === 'object' ? raw : undefined;
      const code: ClientErrorCode =
        (typeof err?.code === 'string' ? (err.code as ApiErrorCode) : undefined) ??
        (res.status === 401
          ? 'unauthorized'
          : res.status === 403
            ? 'forbidden'
            : res.status === 404
              ? 'not_found'
              : res.status === 429
                ? 'rate_limited'
                : res.status >= 500
                  ? 'internal'
                  : 'bad_request');
      throw new ApiRequestError(
        res.status,
        code,
        typeof err?.message === 'string' ? err.message : `HTTP ${res.status}`,
        validSec(err?.retryAfterSec) ?? parseRetryAfter(res.headers.get('Retry-After')),
      );
    }
    if (json === undefined) {
      if (!text) return undefined as T;
      throw new ApiRequestError(res.status, 'bad_response', 'サーバーの応答を解釈できません');
    }
    return json as T;
  }

  return {
    serverUrl: base,
    health: () => request('GET', '/api/health', undefined, false),
    login: (req) => request('POST', '/api/auth/login', req, false),
    logout: () => request('POST', '/api/auth/logout'),
    devices: () => request('GET', '/api/devices'),
    deleteDevice: (id) => request('DELETE', `/api/devices/${encodeURIComponent(id)}`),
    push: (req) => request('POST', '/api/sync/push', req),
    pull: (since, limit = 500) =>
      request('GET', `/api/sync/pull?${new URLSearchParams({ since: String(since), limit: String(limit) })}`),
    summarizeImage: (req) => request('POST', '/api/images/summarize', req),
    semanticSearch: (req) => request('POST', '/api/search/semantic', req),
    getSettings: () => request('GET', '/api/settings'),
    putSettings: (patch) => request('PUT', '/api/settings', patch),
    aiStatus: () => request('GET', '/api/ai/status'),
    vapidPublicKey: () => request('GET', '/api/push/vapid-public-key'),
    subscribePush: (deviceId, subscription) => request('POST', '/api/push/subscriptions', { deviceId, subscription }),
    unsubscribePush: (endpoint) => request('DELETE', '/api/push/subscriptions', { endpoint }),
    exportAll: () => request('GET', '/api/export'),
  };
}

/** ログイン（トークン不要）。成功後 createApiClient(serverUrl, res.token) を使う */
export function login(serverUrl: string, req: LoginRequest, fetchImpl?: FetchLike): Promise<LoginResponse> {
  return createApiClient(serverUrl, null, fetchImpl).login(req);
}
