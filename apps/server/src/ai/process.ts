// 差分スキャン → ジョブ投入、タグ付与・埋め込み生成の小バッチ処理
import type { Ctx } from '../context';
import { BUMP_SEQ, SEQ_VALUE, getState, setState, setStateStmt, stmt, type Stmt } from '../db';
import { quantize, tagVocabulary } from '../embeddings';
import { doneStmt, dueJobs, enqueueStmt, failStmt, type JobRow } from '../jobs';
import type { MemoRow } from '../memos';
import { sha256Hex } from '../util';
import { AiError, generateJson, type AiClient } from './client';
import { DATA_RULE, memoTag } from './prompt';
import { canonicalizeTags, normalizeEmoji } from './tags';

export const SCAN_CURSOR = 'cursor.scan';
const EMBED_MODEL_KEY = 'embed.modelKey';

/** 埋め込みモデル/次元が変わったら埋め込みジョブを作り直し、スキャンを最初からやり直す */
export async function checkEmbedModel(ctx: Ctx, ai: AiClient): Promise<void> {
  const key = `${ai.embedModel}:${ai.embedDim}`;
  const prev = await getState(ctx.db, EMBED_MODEL_KEY);
  if (prev === key) return;
  await ctx.db.batch([
    stmt(`DELETE FROM jobs WHERE kind = 'embed'`),
    stmt(`DELETE FROM embeddings WHERE model != ? OR dim != ?`, ai.embedModel, ai.embedDim),
    setStateStmt(SCAN_CURSOR, '0'),
    setStateStmt(EMBED_MODEL_KEY, key),
  ]);
}

/**
 * server_seq カーソルで変更分を読み、タグ・埋め込みジョブを投入する。
 * AI が無効な間は呼ばないこと（カーソルだけ進むと、その間のメモに埋め込みジョブが作られなくなる）
 */
export async function scanChanges(ctx: Ctx, ai: AiClient, batch: number): Promise<number> {
  const cursor = Number((await getState(ctx.db, SCAN_CURSOR)) ?? '0');
  const rows = await ctx.db.all<Pick<MemoRow, 'id' | 'author' | 'version' | 'tags_version' | 'deleted_at' | 'body' | 'server_seq'>>(
    `SELECT id, author, version, tags_version, deleted_at, body, server_seq FROM memos
     WHERE server_seq > ? ORDER BY server_seq LIMIT ?`,
    cursor,
    batch,
  );
  if (rows.length === 0) return 0;
  const now = ctx.now().toISOString();
  const targets = rows.filter((r) => r.author === 'user' && !r.deleted_at && r.body.trim() !== '');
  const embedded = new Set<string>();
  if (targets.length) {
    const ph = targets.map(() => '?').join(',');
    const es = await ctx.db.all<{ memo_id: string }>(
      `SELECT memo_id FROM embeddings WHERE model = ? AND dim = ? AND memo_id IN (${ph})`,
      ai.embedModel,
      ai.embedDim,
      ...targets.map((t) => t.id),
    );
    for (const e of es) embedded.add(e.memo_id);
  }
  const writes: Stmt[] = [];
  for (const r of targets) {
    if (r.tags_version === null || r.tags_version < r.version) writes.push(enqueueStmt('tag', r.id, r.version, now));
    if (!embedded.has(r.id)) writes.push(enqueueStmt('embed', r.id, r.version, now));
  }
  writes.push(setStateStmt(SCAN_CURSOR, String(rows[rows.length - 1]!.server_seq)));
  await ctx.db.batch(writes);
  return rows.length;
}

async function loadJobMemos(ctx: Ctx, jobs: JobRow[]): Promise<Map<string, MemoRow>> {
  if (jobs.length === 0) return new Map();
  const ph = jobs.map(() => '?').join(',');
  const rows = await ctx.db.all<MemoRow>(`SELECT * FROM memos WHERE id IN (${ph})`, ...jobs.map((j) => j.target_id));
  return new Map(rows.map((r) => [r.id, r]));
}

const TAG_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          tags: { type: 'ARRAY', items: { type: 'STRING' } },
          emoji: { type: 'STRING' },
        },
        required: ['id', 'tags', 'emoji'],
      },
    },
  },
  required: ['items'],
};

/** AI の失敗をジョブに記録。429 は呼び出し元で AI 全体を一時停止させるため再送出 */
async function failAll(ctx: Ctx, jobs: JobRow[], e: unknown): Promise<void> {
  const err = e instanceof AiError ? e : new AiError('failed', String((e as Error)?.message ?? e));
  await ctx.db.batch(jobs.map((j) => failStmt(j, ctx.now(), `${err.kind}: ${err.message}`, err.retryAfterSec)));
  if (err.kind === 'rate_limited' || err.kind === 'unavailable') throw err;
}

export async function runTagJobs(ctx: Ctx, ai: AiClient, limit: number): Promise<number> {
  const jobs = await dueJobs(ctx.db, 'tag', ctx.now(), limit);
  if (jobs.length === 0) return 0;
  const memos = await loadJobMemos(ctx, jobs);
  const nowIso = ctx.now().toISOString();
  const writes: Stmt[] = [];
  const live: { job: JobRow; memo: MemoRow }[] = [];
  for (const j of jobs) {
    const m = memos.get(j.target_id);
    if (!m || m.deleted_at || m.author !== 'user' || (m.tags_version ?? 0) >= m.version) writes.push(doneStmt(j, nowIso));
    else live.push({ job: j, memo: m });
  }
  if (live.length) {
    const vocab = await tagVocabulary(ctx.db);
    let items: { id: string; tags: unknown; emoji?: unknown }[];
    try {
      const r = await generateJson<{ items?: { id: string; tags: unknown; emoji?: unknown }[] }>(ai, {
        system: [
          'あなたは個人用メモに検索用の短いタグを付ける分類器です。',
          DATA_RULE,
          '各メモに 0〜5 個のタグを付けます。タグは話題・対象を表す短い名詞（日本語なら 2〜10 文字程度）。',
          '既存タグに同じ意味のものがあれば必ずその表記を使い、新しい表記揺れを作らないでください。',
          '内容が薄いメモはタグを空にしてかまいません。',
          'あわせて、メモの内容や気持ちを表す絵文字を1つだけ emoji に入れます（例: 📝 💡 ✉️ ☕ 🛠️ 📚 🧪 👍 😮‍💨 🗓️）。',
          '絵文字以外の文字・複数の絵文字は入れないでください。ふさわしいものが無ければ 📝。出力は指定 JSON のみ。',
        ].join('\n'),
        user: [
          `既存タグ: ${vocab.length ? vocab.join(', ') : '(なし)'}`,
          '',
          ...live.map(({ memo }) => memoTag({ id: memo.id }, memo.body, 1500)),
        ].join('\n'),
        schema: TAG_SCHEMA,
        temperature: 0.1,
      });
      items = Array.isArray(r.items) ? r.items : [];
    } catch (e) {
      await failAll(ctx, live.map((l) => l.job), e);
      return 0;
    }
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const { job, memo } of live) {
      const item = byId.get(memo.id);
      const tags = canonicalizeTags(item?.tags ?? [], vocab);
      const emoji = normalizeEmoji(item?.emoji);
      writes.push(
        BUMP_SEQ,
        // 本文版が解析時と同じ・既存より新しい解析結果のときだけ書く（古い結果で上書きしない）
        stmt(
          `UPDATE memos SET tags = ?, emoji = ?, tags_version = ?, updated_at = ?, server_seq = ${SEQ_VALUE}
           WHERE id = ? AND version = ? AND deleted_at IS NULL AND (tags_version IS NULL OR tags_version < ?)`,
          JSON.stringify(tags),
          emoji,
          memo.version,
          nowIso,
          memo.id,
          memo.version,
          memo.version,
        ),
        doneStmt(job, nowIso),
      );
    }
  }
  await ctx.db.batch(writes);
  return live.length;
}

export function embedText(m: Pick<MemoRow, 'body'>): string {
  return m.body.slice(0, 2000);
}

export async function runEmbedJobs(ctx: Ctx, ai: AiClient, limit: number): Promise<number> {
  const jobs = await dueJobs(ctx.db, 'embed', ctx.now(), limit);
  if (jobs.length === 0) return 0;
  const memos = await loadJobMemos(ctx, jobs);
  const nowIso = ctx.now().toISOString();
  const writes: Stmt[] = [];
  const live: { job: JobRow; memo: MemoRow }[] = [];
  for (const j of jobs) {
    const m = memos.get(j.target_id);
    if (!m || m.deleted_at || m.body.trim() === '') writes.push(doneStmt(j, nowIso));
    else live.push({ job: j, memo: m });
  }
  if (live.length) {
    let vecs: number[][];
    try {
      vecs = await ai.embed(live.map((l) => embedText(l.memo)), 'RETRIEVAL_DOCUMENT');
    } catch (e) {
      await failAll(ctx, live.map((l) => l.job), e);
      return 0;
    }
    for (let i = 0; i < live.length; i++) {
      const { job, memo } = live[i]!;
      const q = quantize(vecs[i]!);
      writes.push(
        stmt(
          `INSERT INTO embeddings (memo_id, body_hash, model, dim, vector, scale, memo_created_at, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM memos WHERE id = ? AND version = ? AND deleted_at IS NULL)
           ON CONFLICT(memo_id) DO UPDATE SET body_hash = excluded.body_hash, model = excluded.model, dim = excluded.dim,
             vector = excluded.vector, scale = excluded.scale, created_at = excluded.created_at`,
          memo.id,
          await sha256Hex(memo.body),
          ai.embedModel,
          ai.embedDim,
          q.vector,
          q.scale,
          memo.created_at,
          nowIso,
          memo.id,
          memo.version,
        ),
        doneStmt(job, nowIso),
      );
    }
  }
  await ctx.db.batch(writes);
  return live.length;
}

