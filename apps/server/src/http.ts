import type { ApiErrorCode } from '@cuenu/core';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorCode,
    message: string,
    public retryAfterSec?: number,
  ) {
    super(message);
  }
}

/** API 応答の共通ヘッダー（キャッシュさせない・MIME スニッフィング禁止） */
const SECURITY_HEADERS: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: SECURITY_HEADERS });
}

export function errorResponse(e: HttpError): Response {
  const body: { error: { code: ApiErrorCode; message: string; retryAfterSec?: number } } = {
    error: { code: e.code, message: e.message },
  };
  const headers: Record<string, string> = {};
  if (e.retryAfterSec !== undefined) {
    body.error.retryAfterSec = e.retryAfterSec;
    headers['retry-after'] = String(e.retryAfterSec);
  }
  return json(body, e.status, headers);
}

export const badRequest = (m: string) => new HttpError(400, 'bad_request', m);

export async function readJson<T>(req: Request, maxBytes = 1_000_000): Promise<T> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > maxBytes) throw new HttpError(413, 'bad_request', 'request too large');
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'bad_request', 'request too large');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw badRequest('invalid JSON');
  }
}

// ---- CORS ----
const TAURI_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];

export function allowedOrigin(req: Request, extra: string | undefined): string | null {
  const origin = req.headers.get('origin');
  if (!origin) return null;
  const self = new URL(req.url).origin;
  const list = [
    ...TAURI_ORIGINS,
    self,
    ...(extra ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ];
  return list.includes(origin) ? origin : null;
}

export function withCors(res: Response, origin: string | null): Response {
  if (!origin) return res;
  const r = new Response(res.body, res);
  r.headers.set('access-control-allow-origin', origin);
  r.headers.append('vary', 'Origin');
  r.headers.set('access-control-expose-headers', 'Retry-After');
  return r;
}

export function preflight(origin: string | null): Response {
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-max-age': '600',
      vary: 'Origin',
    },
  });
}
