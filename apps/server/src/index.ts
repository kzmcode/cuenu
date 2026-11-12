import { createAiClient } from './ai/gemini';
import { handleApi } from './app';
import type { Ctx } from './context';
import { runCron } from './cron';
import { d1Db } from './db';
import type { Env, ExecutionContext, ScheduledController } from './env';

function makeCtx(env: Env): Ctx {
  return { db: d1Db(env.DB), env, now: () => new Date(), ai: createAiClient(env), fetch: (i, init) => fetch(i, init) };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') return handleApi(makeCtx(env), req);
    // run_worker_first が /api/* のみなので通常ここには来ないが、念のため静的アセットへ委譲
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('Not found', { status: 404 });
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runCron(makeCtx(env)).then(
        (r) => console.log('cron', JSON.stringify({ ...r, posted: r.posted.length })),
        (e) => console.error('cron failed', e),
      ),
    );
  },
};
