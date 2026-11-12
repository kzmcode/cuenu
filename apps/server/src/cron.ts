// Cron Triggers の定期処理。1 回の実行は小バッチに限定し、残りは次回に回す。
import { AiError } from './ai/client';
import { evaluateFeedback } from './ai/feedback';
import { refreshMemory } from './ai/memory';
import { generatePosts } from './ai/posts';
import { checkEmbedModel, runEmbedJobs, runTagJobs, scanChanges } from './ai/process';
import { K, clearAiError, pauseAi, pausedUntil, recordAiError } from './ai/status';
import { purgeStaleDevices } from './auth';
import type { Ctx } from './context';
import { acquireLock, releaseLock, setState, stmt } from './db';
import { intVar } from './env';
import { notifyPendingPosts } from './push/notify';
import { getSettings } from './settings';

export interface CronReport {
  skipped?: 'locked';
  scanned: number;
  tagged: number;
  embedded: number;
  feedback: number;
  memory: number;
  posted: string[];
  postReason: string | null;
  notified: number;
  errors: string[];
}

const LOCK_MS = 10 * 60_000;
const SYNC_OPS_RETENTION_DAYS = 180;

export async function runCron(ctx: Ctx): Promise<CronReport> {
  const report: CronReport = { scanned: 0, tagged: 0, embedded: 0, feedback: 0, memory: 0, posted: [], postReason: null, notified: 0, errors: [] };
  const owner = crypto.randomUUID();
  if (!(await acquireLock(ctx.db, 'cron', owner, ctx.now(), LOCK_MS))) return { ...report, skipped: 'locked' };
  try {
    const batch = intVar(ctx.env.CRON_BATCH_SIZE, 10, 1, 50);
    const settings = await getSettings(ctx.db);
    const ai = settings.aiEnabled ? ctx.ai : null;
    if (ai) {
      await checkEmbedModel(ctx, ai);
      report.scanned = await scanChanges(ctx, ai, 200);
    }

    if (ai && !(await pausedUntil(ctx.db, ctx.now()))) {
      await setState(ctx.db, K.lastRunAt, ctx.now().toISOString());
      try {
        report.tagged = await runTagJobs(ctx, ai, batch);
        report.embedded = await runEmbedJobs(ctx, ai, batch * 2);
        // 過去の AI 投稿への反応を評価してから、次の提案を検討する
        report.feedback = await evaluateFeedback(ctx, ai);
        // 古いメモの週・月の要約（長期記憶）を必要な分だけ作り直す。
        // 429/認証エラー以外の失敗（不正な応答等）で提案生成まで止めない
        try {
          report.memory = await refreshMemory(ctx, ai, settings);
        } catch (e) {
          if (!(e instanceof AiError) || e.kind === 'rate_limited' || e.kind === 'unavailable') throw e;
          report.errors.push(`memory: ${e.message}`);
          await recordAiError(ctx.db, `memory: ${e.message}`);
        }
        const r = await generatePosts(ctx, ai, settings);
        report.posted = r.posted;
        report.postReason = r.reason;
        // AI の処理が最後まで成功したら、前回までのエラー表示を消す
        if (report.errors.length === 0) await clearAiError(ctx.db);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        report.errors.push(msg);
        await recordAiError(ctx.db, msg);
        if (e instanceof AiError && e.kind === 'rate_limited') await pauseAi(ctx.db, ctx.now(), e.retryAfterSec ?? 300);
        if (e instanceof AiError && e.kind === 'unavailable') await pauseAi(ctx.db, ctx.now(), 3600);
        if (!(e instanceof AiError)) console.error('cron ai step failed', e);
      }
    }

    try {
      // パスワード変更前の端末へ通知を送らない
      await purgeStaleDevices(ctx);
      report.notified = await notifyPendingPosts(ctx);
    } catch (e) {
      report.errors.push(`notify: ${(e as Error).message}`);
    }

    await cleanup(ctx);
  } finally {
    await releaseLock(ctx.db, 'cron', owner);
  }
  return report;
}

async function cleanup(ctx: Ctx): Promise<void> {
  const now = ctx.now().getTime();
  const old = new Date(now - SYNC_OPS_RETENTION_DAYS * 86400_000).toISOString();
  const day = new Date(now - 86400_000).toISOString();
  const month = new Date(now - 30 * 86400_000).toISOString();
  await ctx.db.batch([
    stmt(`DELETE FROM sync_ops WHERE op_id IN (SELECT op_id FROM sync_ops WHERE applied_at < ? LIMIT 500)`, old),
    stmt(`DELETE FROM login_attempts WHERE window_start < ? AND (locked_until IS NULL OR locked_until < ?)`, day, ctx.now().toISOString()),
    stmt(`DELETE FROM push_deliveries WHERE sent_at < ?`, month),
    stmt(`DELETE FROM jobs WHERE status = 'done' AND updated_at < ?`, month),
  ]);
}
