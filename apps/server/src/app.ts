import {
  API_VERSION,
  type AiStatusResponse,
  type ExportBundle,
  type HealthResponse,
  type ImageSummarizeRequest,
  type LoginRequest,
  type PushRequest,
  type SemanticSearchRequest,
} from '@cuenu/core';
import { AiError, type AiClient } from './ai/client';
import { postsToday } from './ai/posts';
import { K, pauseAi, pausedUntil } from './ai/status';
import { authenticate, clientIp, listDevices, login, revokeDevice, type DeviceRow } from './auth';
import type { Ctx } from './context';
import { runCron } from './cron';
import { getState } from './db';
import { semanticSearch } from './embeddings';
import { HttpError, allowedOrigin, errorResponse, json, noContent, preflight, readJson, withCors } from './http';
import { summarizeImage } from './images';
import { pendingJobCount } from './jobs';
import { rowToMemo, type MemoRow } from './memos';
import { deleteSubscription, saveSubscription } from './push/notify';
import { getSettings, putSettings } from './settings';
import { parsePullParams, pull, push } from './sync';

const MIN_CLIENT_API_VERSION = 1;

export async function handleApi(ctx: Ctx, req: Request): Promise<Response> {
  const origin = allowedOrigin(req, ctx.env.CORS_ORIGINS);
  if (req.method === 'OPTIONS') return preflight(origin);
  let res: Response;
  try {
    res = await route(ctx, req);
  } catch (e) {
    if (e instanceof HttpError) res = errorResponse(e);
    else if (e instanceof AiError) res = errorResponse(aiHttpError(e));
    else {
      console.error('unhandled', e);
      res = errorResponse(new HttpError(500, 'internal', 'internal error'));
    }
  }
  return withCors(res, origin);
}

function aiHttpError(e: AiError): HttpError {
  if (e.kind === 'rate_limited') return new HttpError(429, 'rate_limited', 'AI rate limited', e.retryAfterSec ?? 60);
  return new HttpError(503, 'ai_unavailable', e.message);
}

async function requireAi(ctx: Ctx): Promise<AiClient> {
  if (!ctx.ai) throw new HttpError(503, 'ai_unavailable', 'AI is not configured (GEMINI_API_KEY)');
  const s = await getSettings(ctx.db);
  if (!s.aiEnabled) throw new HttpError(503, 'ai_unavailable', 'AI is disabled in settings');
  const until = await pausedUntil(ctx.db, ctx.now());
  if (until) {
    const sec = Math.max(1, Math.ceil((Date.parse(until) - ctx.now().getTime()) / 1000));
    throw new HttpError(429, 'rate_limited', 'AI is paused due to rate limit', sec);
  }
  return ctx.ai;
}

async function withAiPause<T>(ctx: Ctx, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof AiError && e.kind === 'rate_limited') await pauseAi(ctx.db, ctx.now(), e.retryAfterSec ?? 60);
    throw e;
  }
}

async function route(ctx: Ctx, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;

  const clientVer = req.headers.get('x-cuenu-api-version');
  if (clientVer && Number(clientVer) < MIN_CLIENT_API_VERSION) {
    throw new HttpError(426, 'incompatible_client', `client API ${clientVer} < ${MIN_CLIENT_API_VERSION}; please update`);
  }

  if (path === '/api/health' && m === 'GET') {
    const body: HealthResponse = {
      name: 'cuenu',
      apiVersion: API_VERSION,
      minClientApiVersion: MIN_CLIENT_API_VERSION,
      serverTime: ctx.now().toISOString(),
    };
    return json(body);
  }
  if (path === '/api/auth/login' && m === 'POST') {
    return json(await login(ctx, await readJson<LoginRequest>(req, 10_000), clientIp(req)));
  }

  if (!path.startsWith('/api/')) throw new HttpError(404, 'not_found', 'not found');
  const dev = await authenticate(ctx, req);
  return authed(ctx, req, url, path, m, dev);
}

async function authed(ctx: Ctx, req: Request, url: URL, path: string, m: string, dev: DeviceRow): Promise<Response> {
  switch (`${m} ${path}`) {
    case 'POST /api/auth/logout':
      await revokeDevice(ctx, dev.id);
      return noContent();
    case 'GET /api/devices':
      return json(await listDevices(ctx, dev.id));
    case 'POST /api/sync/push': {
      const body = await readJson<PushRequest>(req, 25_000_000);
      return json(await push(ctx, dev.id, body));
    }
    case 'GET /api/sync/pull': {
      const { since, limit } = parsePullParams(url);
      return json(await pull(ctx, since, limit));
    }
    case 'GET /api/settings':
      return json(await getSettings(ctx.db));
    case 'PUT /api/settings':
      return json(await putSettings(ctx.db, await readJson(req, 10_000)));
    case 'GET /api/ai/status': {
      const settings = await getSettings(ctx.db);
      const body: AiStatusResponse = {
        configured: !!ctx.ai,
        enabled: settings.aiEnabled,
        lastRunAt: await getState(ctx.db, K.lastRunAt),
        lastError: await getState(ctx.db, K.lastError),
        postsToday: await postsToday(ctx, settings),
        dailyLimit: settings.dailyAiPostLimit,
        pausedUntil: await pausedUntil(ctx.db, ctx.now()),
        pendingJobs: await pendingJobCount(ctx.db),
      };
      return json(body);
    }
    case 'POST /api/ai/run':
      // 拡張: 定期処理を手動実行（ローカル検証用。ロック・日次上限は通常どおり）
      return json(await runCron(ctx));
    case 'GET /api/export': {
      const rows = await ctx.db.all<MemoRow>(`SELECT * FROM memos WHERE deleted_at IS NULL ORDER BY created_at`);
      const body: ExportBundle = { app: 'cuenu', format: 1, exportedAt: ctx.now().toISOString(), memos: rows.map(rowToMemo) };
      return json(body, 200, { 'content-disposition': `attachment; filename="cuenu-export.json"` });
    }
    case 'POST /api/images/summarize': {
      const body = await readJson<ImageSummarizeRequest>(req, 6_000_000);
      const ai = await requireAi(ctx);
      return json(await withAiPause(ctx, () => summarizeImage(ai, body)));
    }
    case 'POST /api/search/semantic': {
      const body = await readJson<SemanticSearchRequest>(req, 10_000);
      if (typeof body?.query !== 'string' || !body.query.trim()) throw new HttpError(400, 'bad_request', 'query required');
      const limit = Math.min(50, Math.max(1, Number.isInteger(body.limit) ? body.limit! : 20));
      const ai = await requireAi(ctx);
      return json(await withAiPause(ctx, () => semanticSearch(ctx.db, ctx.env, ai, body.query.trim(), limit)));
    }
    case 'GET /api/push/vapid-public-key':
      if (!ctx.env.VAPID_PUBLIC_KEY) throw new HttpError(404, 'not_found', 'Web Push is not configured');
      return json({ publicKey: ctx.env.VAPID_PUBLIC_KEY });
    case 'POST /api/push/subscriptions':
      await saveSubscription(ctx, dev.id, await readJson(req, 10_000));
      return noContent();
    case 'DELETE /api/push/subscriptions':
      await deleteSubscription(ctx, await readJson(req, 10_000));
      return noContent();
  }
  const dm = /^\/api\/devices\/([^/]+)$/.exec(path);
  if (dm && m === 'DELETE') {
    let id: string;
    try {
      id = decodeURIComponent(dm[1]!);
    } catch {
      throw new HttpError(404, 'not_found', 'device not found'); // 不正な %エンコード
    }
    if (!(await revokeDevice(ctx, id))) throw new HttpError(404, 'not_found', 'device not found');
    return noContent();
  }
  throw new HttpError(404, 'not_found', 'not found');
}
