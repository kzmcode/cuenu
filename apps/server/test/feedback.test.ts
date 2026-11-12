import type { PushOp, SyncMemoPayload } from '@cuenu/core';
import { describe, expect, test } from 'vitest';
import type { GenerateOptions } from '../src/ai/client';
import { evaluateFeedback, evaluateReaction, kindMinConfidence, loadFeedback, ruleLabel } from '../src/ai/feedback';
import { feedbackLines, filterCandidates } from '../src/ai/posts';
import { runCron } from '../src/cron';
import { getMemo } from '../src/memos';
import { putSettings } from '../src/settings';
import { push } from '../src/sync';
import { MockAi, makeCtx, type TestCtx } from './helpers';

let n = 0;
const payload = (id: string, body: string, extra: Partial<SyncMemoPayload> = {}): SyncMemoPayload => ({
  id,
  parentId: null,
  body,
  createdAt: '2026-11-04T01:00:00.000Z',
  editedAt: null,
  version: 1,
  image: null,
  ...extra,
});
const up = (m: SyncMemoPayload, base: number): PushOp => ({ opId: `fop${++n}`, memoId: m.id, kind: 'upsert', baseVersion: base, memo: m });
const pushOne = (ctx: TestCtx, op: PushOp) => push(ctx, 'dev', { deviceId: 'dev', ops: [op] });
const now = new Date('2026-11-10T00:00:00.000Z');
const kindOf = (o: GenerateOptions) => Object.keys((o.schema as { properties?: object })?.properties ?? {})[0];

/** AI 投稿を 1 件作る（cron 経由）。返り値は AI 投稿の id */
async function makeAiPost(ctx: TestCtx, ai: MockAi, srcId: string, body: string): Promise<string> {
  await pushOne(ctx, up(payload(srcId, body), 0));
  const r = await runCron(ctx);
  expect(r.posted).toHaveLength(1);
  return r.posted[0]!;
}

function aiForPosts(labels: Record<string, string> = {}): MockAi {
  const ai = new MockAi();
  ai.handler = (o) => {
    const k = kindOf(o);
    if (k === 'items') return JSON.stringify({ items: [] });
    if (k === 'labels') {
      const ids = [...o.user.matchAll(/<memo id="([^"]+)" role="user_reply"/g)].map((m) => m[1]!);
      return JSON.stringify({ labels: ids.map((id) => ({ id, label: labels[id] ?? 'neutral' })) });
    }
    const mm = /<memo id="([^"]+)"[^>]*kind="new"/.exec(o.user);
    return JSON.stringify({
      posts: mm ? [{ kind: 'action', body: `次の一歩を試してみませんか（${mm[1]}）`, sourceIds: [mm[1]], confidence: 0.9, summary: `提案 ${mm[1]}` }] : [],
    });
  };
  return ai;
}

describe('反応の評価（純関数）', () => {
  test('返信の規則判定', () => {
    expect(ruleLabel('今回は見送る')).toBe('declined');
    expect(ruleLabel('送った。完了')).toBe('done');
    expect(ruleLabel('採用。週末に試す')).toBe('adopted');
    expect(ruleLabel('あとで考える')).toBe('later');
    expect(ruleLabel('なるほど')).toBeNull();
  });

  test('非表示・いいね・最新の返信・無反応', () => {
    const base = { hidden: false, liked: false, replyLabels: [] as never[], createdAt: '2026-11-09T00:00:00.000Z' };
    expect(evaluateReaction({ ...base, hidden: true, liked: true }, now)).toEqual({ signal: 'hidden', score: -1 });
    expect(evaluateReaction({ ...base, liked: true }, now)).toMatchObject({ signal: 'liked', score: 0.8 });
    // 「採用」のあと「やめた」→ 最新の意思（見送り）を優先。いいね済みでも負
    const r = evaluateReaction({ ...base, liked: true, replyLabels: ['adopted', 'declined'] }, now);
    expect(r.signal).toBe('declined');
    expect(r.score).toBeLessThan(0);
    // 72 時間未満の無反応は評価待ち、超えたら弱い否定
    expect(evaluateReaction(base, now).signal).toBe('pending');
    expect(evaluateReaction({ ...base, createdAt: '2026-11-01T00:00:00.000Z' }, now)).toEqual({ signal: 'ignored', score: -0.4 });
    expect(evaluateReaction({ ...base, replyLabels: ['neutral'] }, now)).toMatchObject({ signal: 'replied', score: 0.3 });
  });

  test('種別のしきい値は 3 件以上の評価で上下し、範囲内に収まる', () => {
    expect(kindMinConfidence({ action: { n: 2, avg: -1 } }, 'action', 0.6)).toBe(0.6);
    expect(kindMinConfidence({ action: { n: 5, avg: -1 } }, 'action', 0.6)).toBeCloseTo(0.8);
    expect(kindMinConfidence({ action: { n: 5, avg: 1 } }, 'action', 0.6)).toBe(0.5);
  });

  test('フィルタ: 種別しきい値と、不評だった提案に近いものの除外', () => {
    const f = {
      allowedIds: new Set(['a']),
      newIds: new Set(['a']),
      declinedIds: new Set<string>(),
      pastSourceKeys: new Set<string>(),
      pastSummaries: [],
      maxPosts: 3,
    };
    const post = (kind: string, confidence: number, summary: string) => ({ kind, body: '十分な長さの提案本文です。', sourceIds: ['a'], confidence, summary });
    expect(filterCandidates({ posts: [post('action', 0.7, 'x')] }, { ...f, minConfidence: { action: 0.8 } })).toHaveLength(0);
    expect(filterCandidates({ posts: [post('related', 0.7, 'x')] }, { ...f, minConfidence: { action: 0.8 } })).toHaveLength(1);
    expect(
      filterCandidates({ posts: [post('action', 0.9, '週末に入力欄を試作する')] }, { ...f, negativeSummaries: ['週末に入力欄の試作をする'] }),
    ).toHaveLength(0);
  });
});

describe('いいねの同期と評価', () => {
  test('AI 投稿はいいねだけ変更でき、本文・版は変わらない', async () => {
    const ai = aiForPosts();
    const ctx = makeCtx({ ai });
    const id = await makeAiPost(ctx, ai, 's1', '入力の速いメモアプリを作りたい');
    const ai1 = (await getMemo(ctx.db, id))!;
    expect(ai1.liked).toBe(false);
    const p = { id, parentId: null, body: ai1.body, createdAt: ai1.createdAt, editedAt: null, version: 1, image: null };
    const r = await pushOne(ctx, up({ ...p, liked: true }, 1));
    expect(r.results[0]?.status).toBe('applied');
    const ai2 = (await getMemo(ctx.db, id))!;
    expect(ai2.liked).toBe(true);
    expect(ai2.version).toBe(1);
    expect(ai2.serverSeq).toBeGreaterThan(ai1.serverSeq!);
    // 本文の変更は従来どおり拒否
    expect((await pushOne(ctx, up({ ...p, body: '改ざん' }, 1))).results[0]?.status).toBe('rejected');
    // ユーザーのメモに liked を送っても無視される
    await pushOne(ctx, up({ ...payload('s1', '入力の速いメモアプリを作りたい'), liked: true } as SyncMemoPayload, 1));
    expect((await getMemo(ctx.db, 's1'))?.liked).toBe(false);
  });

  test('いいね・返信（規則/AI 分類）・非表示を評価し、次のプロンプトに反応として渡す', async () => {
    const ai = aiForPosts({ r3: 'declined' });
    const ctx = makeCtx({ ai });
    await putSettings(ctx.db, { dailyAiPostLimit: 10 });
    const a1 = await makeAiPost(ctx, ai, 's1', 'メモアプリを作りたい');
    ctx.clock.t += 3600_000;
    const a2 = await makeAiPost(ctx, ai, 's2', '週末に読書したい');
    ctx.clock.t += 3600_000;
    const a3 = await makeAiPost(ctx, ai, 's3', '部屋を片付けたい');

    const aiPayload = async (id: string) => {
      const m = (await getMemo(ctx.db, id))!;
      return { id, parentId: null, body: m.body, createdAt: m.createdAt, editedAt: null, version: 1, image: null };
    };
    await pushOne(ctx, up({ ...(await aiPayload(a1)), liked: true }, 1));
    await pushOne(ctx, up(payload('r2', '採用。やってみる', { parentId: a2 }), 0));
    await pushOne(ctx, up(payload('r3', 'うーん、それは違うかな', { parentId: a3 }), 0)); // 規則で判定できない → AI 分類
    await evaluateFeedback(ctx, ai);

    const fb = await loadFeedback(ctx.db);
    expect(fb.bySignal.get(a1)).toBe('liked');
    expect(fb.bySignal.get(a2)).toBe('adopted');
    expect(fb.bySignal.get(a3)).toBe('declined');
    expect(ai.calls.some((c) => kindOf(c) === 'labels')).toBe(true);

    // 次の提案生成のプロンプトに反応が入る
    await pushOne(ctx, up(payload('s4', '新しい用事'), 0));
    ctx.clock.t += 3600_000;
    await runCron(ctx);
    const prompt = ai.calls.filter((c) => kindOf(c) === 'posts').at(-1)!;
    expect(prompt.user).toContain('過去の提案へのユーザーの反応');
    expect(prompt.user).toContain('→ いいね');
    expect(prompt.user).toContain('→ 見送り・不要');
    expect(prompt.user).toMatch(/feedback=liked/);
    expect(feedbackLines(fb).length).toBeGreaterThan(0);

    // 分類済みの返信は再分類しない（AI を再度呼ばない）
    const labelCalls = ai.calls.filter((c) => kindOf(c) === 'labels').length;
    await evaluateFeedback(ctx, ai);
    expect(ai.calls.filter((c) => kindOf(c) === 'labels').length).toBe(labelCalls);
  });

  test('非表示と無反応（72 時間後）', async () => {
    const ai = aiForPosts();
    const ctx = makeCtx({ ai });
    const a1 = await makeAiPost(ctx, ai, 's1', 'メモアプリを作りたい');
    ctx.clock.t += 3600_000;
    const a2 = await makeAiPost(ctx, ai, 's2', '週末に読書したい');
    await pushOne(ctx, { opId: 'del-a1', memoId: a1, kind: 'delete', baseVersion: 1, memo: null });
    await evaluateFeedback(ctx, ai);
    let fb = await loadFeedback(ctx.db);
    expect(fb.bySignal.get(a1)).toBe('hidden');
    expect(fb.bySignal.get(a2)).toBe('pending');
    ctx.clock.t += 73 * 3600_000;
    await evaluateFeedback(ctx, ai);
    fb = await loadFeedback(ctx.db);
    expect(fb.bySignal.get(a2)).toBe('ignored');
  });
});
