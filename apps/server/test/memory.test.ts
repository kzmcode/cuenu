import type { PushOp, SyncMemoPayload } from '@cuenu/core';
import { describe, expect, test } from 'vitest';
import type { GenerateOptions } from '../src/ai/client';
import { MAX_PER_RUN, loadMemoryContext, refreshMemory } from '../src/ai/memory';
import { runCron } from '../src/cron';
import { getSettings } from '../src/settings';
import { push } from '../src/sync';
import { addDays, weekStart } from '../src/util';
import { MockAi, makeCtx, type TestCtx } from './helpers';

let n = 0;
const memo = (id: string, body: string, createdAt: string, version = 1): SyncMemoPayload => ({
  id,
  parentId: null,
  body,
  createdAt,
  editedAt: version > 1 ? createdAt : null,
  version,
  image: null,
});
const up = (m: SyncMemoPayload, base: number): PushOp => ({ opId: `mop${++n}`, memoId: m.id, kind: 'upsert', baseVersion: base, memo: m });
const pushOne = (ctx: TestCtx, op: PushOp) => push(ctx, 'dev', { deviceId: 'dev', ops: [op] });
const kindOf = (o: GenerateOptions) => Object.keys((o.schema as { properties?: object })?.properties ?? {})[0];

/** 要約は「期間＋メモ件数」を返すモック。投稿生成のプロンプトは記録だけする */
function memoryAi() {
  const ai = new MockAi();
  ai.handler = (o) => {
    const k = kindOf(o);
    if (k === 'summary') {
      const period = /期間: (\S+)/.exec(o.user)?.[1] ?? '?';
      const count = (o.user.match(/<memo /g) ?? []).length || (o.user.match(/<digest /g) ?? []).length;
      return JSON.stringify({ summary: `要約 ${period} 件数${count}`, topics: ['アプリ開発'] });
    }
    if (k === 'items') return JSON.stringify({ items: [] });
    if (k === 'labels') return JSON.stringify({ labels: [] });
    return JSON.stringify({ posts: [] });
  };
  return ai;
}
const summaryCalls = (ai: MockAi) => ai.calls.filter((c) => kindOf(c) === 'summary');
const jst = (date: string, hh = '12') => new Date(`${date}T${hh}:00:00+09:00`).toISOString();

describe('長期記憶（週・月の要約）', () => {
  test('直近 14 日のメモは要約せず、それより前の完了した週だけを要約する', async () => {
    const ai = memoryAi();
    const ctx = makeCtx({ ai }); // 現在 2026-11-04（水）JST
    await pushOne(ctx, up(memo('recent', '最近のメモ', jst('2026-10-28')), 0)); // 7 日前 → 要約しない
    await pushOne(ctx, up(memo('w1a', '3 週間前のメモA', jst('2026-10-13')), 0));
    await pushOne(ctx, up(memo('w1b', '3 週間前のメモB', jst('2026-10-15')), 0));
    await pushOne(ctx, up(memo('w2', '5 週間前のメモ', jst('2026-09-29')), 0));
    const settings = await getSettings(ctx.db);
    expect(await refreshMemory(ctx, ai, settings)).toBe(2);
    const rows = await ctx.db.all<{ id: string; memo_count: number; summary: string }>(`SELECT id, memo_count, summary FROM ai_memory ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual(['week:2026-09-28', 'week:2026-10-12']);
    expect(rows.find((r) => r.id === 'week:2026-10-12')?.memo_count).toBe(2);
    // 週の境界（月曜 0:00 JST）で区切られ、最近のメモは要約に入らない
    expect(summaryCalls(ai).every((c) => !c.user.includes('最近のメモ'))).toBe(true);

    // 変化がなければ作り直さない
    const calls = summaryCalls(ai).length;
    expect(await refreshMemory(ctx, ai, settings)).toBe(0);
    expect(summaryCalls(ai).length).toBe(calls);
  });

  test('過去のメモが編集・削除されたら、その週だけ作り直す／空になったら消す', async () => {
    const ai = memoryAi();
    const ctx = makeCtx({ ai });
    await pushOne(ctx, up(memo('a', '古いメモA', jst('2026-10-13')), 0));
    await pushOne(ctx, up(memo('b', '古いメモB', jst('2026-09-29')), 0));
    const settings = await getSettings(ctx.db);
    await refreshMemory(ctx, ai, settings);
    const calls = summaryCalls(ai).length;

    await pushOne(ctx, up(memo('a', '古いメモA（あとで追記）', jst('2026-10-13'), 2), 1));
    expect(await refreshMemory(ctx, ai, settings)).toBe(1);
    expect(summaryCalls(ai).length).toBe(calls + 1);
    expect(summaryCalls(ai).at(-1)!.user).toContain('あとで追記');

    await pushOne(ctx, { opId: 'del-b', memoId: 'b', kind: 'delete', baseVersion: 1, memo: null });
    await refreshMemory(ctx, ai, settings);
    const ids = (await ctx.db.all<{ id: string }>(`SELECT id FROM ai_memory`)).map((r) => r.id);
    expect(ids).toEqual(['week:2026-10-12']);
  });

  test('1 回に作る要約は上限まで（残りは次回）。90 日より前の月は週の要約をまとめる', async () => {
    const ai = memoryAi();
    const ctx = makeCtx({ ai });
    // 2026-05〜06 に週 1 件ずつ（90 日より前）
    let d = '2026-05-04';
    let i = 0;
    while (d < '2026-07-01') {
      await pushOne(ctx, up(memo(`old${i++}`, `古いメモ ${d}`, jst(d)), 0));
      d = addDays(d, 7);
    }
    const settings = await getSettings(ctx.db);
    expect(await refreshMemory(ctx, ai, settings)).toBe(MAX_PER_RUN);
    for (let k = 0; k < 10; k++) await refreshMemory(ctx, ai, settings);
    const rows = await ctx.db.all<{ id: string; level: string; memo_count: number; summary: string }>(`SELECT * FROM ai_memory ORDER BY id`);
    const weeks = rows.filter((r) => r.level === 'week');
    const months = rows.filter((r) => r.level === 'month');
    expect(weeks).toHaveLength(i);
    expect(months.map((m) => m.id)).toEqual(['month:2026-05', 'month:2026-06']);
    // 月の要約は週の要約（digest）から作る
    const monthCall = summaryCalls(ai).find((c) => c.user.includes('期間: 2026-05（'))!;
    expect(monthCall.user).toContain('<digest');
    expect(months.find((m) => m.id === 'month:2026-05')?.memo_count).toBe(weeks.filter((w) => w.id.startsWith('week:2026-05')).length);

    // 提案生成用の文脈: 古い月は月の要約だけ（同じ月の週の要約は重ねない）
    const mem = await loadMemoryContext(ctx.db, settings, ctx.now());
    expect(mem.some((m) => m.id === 'month:2026-05')).toBe(true);
    expect(mem.some((m) => m.id.startsWith('week:2026-05'))).toBe(false);
  });

  test('定期処理の提案生成プロンプトに要約が入る', async () => {
    const ai = memoryAi();
    const ctx = makeCtx({ ai });
    await pushOne(ctx, up(memo('old', '古い本文そのもの', jst('2026-10-06')), 0));
    await runCron(ctx); // 要約を作る（新しい入力もあるので提案も検討される）
    await pushOne(ctx, up(memo('new', '今日の新しいメモ', jst('2026-11-04', '11')), 0));
    ctx.clock.t += 3600_000;
    const r = await runCron(ctx);
    expect(r.errors).toEqual([]);
    const prompt = ai.calls.filter((c) => kindOf(c) === 'posts').at(-1)!;
    expect(prompt.user).toContain('## 長期の記録の要約');
    expect(prompt.user).toContain(`<digest level="週" period="${weekStart('2026-10-06')}〜`);
    expect(prompt.user).toContain('今日の新しいメモ');
    expect(prompt.system).toContain('<digest> は古い期間のメモを要約したもの');
  });

  test('空・不正な要約応答でも 1 回の AI 呼び出し数は上限まで、提案生成は止まらない', async () => {
    const ai = memoryAi();
    const base = ai.handler;
    ai.handler = (o) => (kindOf(o) === 'summary' ? JSON.stringify({ summary: '', topics: [] }) : base(o));
    const ctx = makeCtx({ ai });
    let d = '2026-05-04';
    let i = 0;
    while (d < '2026-07-01') {
      await pushOne(ctx, up(memo(`old${i++}`, `古いメモ ${d}`, jst(d)), 0));
      d = addDays(d, 7);
    }
    const settings = await getSettings(ctx.db);
    expect(await refreshMemory(ctx, ai, settings)).toBe(0);
    expect(summaryCalls(ai)).toHaveLength(MAX_PER_RUN);

    // 不正な JSON（bad_response）でも定期処理の提案生成までは進む
    ai.handler = (o) => (kindOf(o) === 'summary' ? '{"summary": "途中で切れ' : base(o));
    await pushOne(ctx, up(memo('new', '今日の新しいメモ', jst('2026-11-04', '11')), 0));
    const r = await runCron(ctx);
    expect(r.errors.some((e) => e.startsWith('memory:'))).toBe(true);
    expect(ai.calls.some((c) => kindOf(c) === 'posts')).toBe(true);
  });
});
