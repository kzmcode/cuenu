// 1万件の日本語メモでのローカル検索ベンチ（目標 500ms 以内）。結果は docs/client.md に記録。
import { describe, expect, it } from 'vitest';
import type { StoredMemo } from '../backend';
import { createMemoryRepository } from '../factories';

// core はブラウザ向けで @types/node を入れていない。ベンチの表示にだけ使う
declare const process: { version: string; platform: string; arch: string };

const WORDS = [
  '今日は', 'アプリ案', '会議', 'メモ', '同期', '買い物リスト', '読書', '散歩', 'アイデア', '仕事',
  'プログラミング', 'コーヒー', '設計', '振り返り', 'タスク', '旅行', '映画', '健康', '日記', 'Markdown',
  'を考えた', 'について', 'が気になる', 'をまとめる', 'したい', 'だった', 'の続き', 'を試す', '。', '、',
];

function rand(seed: number) {
  let x = seed;
  return () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32);
}

function makeMemos(n: number): StoredMemo[] {
  const r = rand(42);
  const out: StoredMemo[] = [];
  const base = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const len = 20 + Math.floor(r() * 80);
    let body = '';
    for (let j = 0; j < len; j++) body += WORDS[Math.floor(r() * WORDS.length)];
    const t = new Date(base + i * 60_000).toISOString();
    const isReply = i > 0 && r() < 0.2;
    out.push({
      id: `m${i}`,
      parentId: isReply ? `m${Math.floor(r() * i)}` : null,
      author: r() < 0.05 ? 'ai' : 'user',
      body,
      createdAt: t,
      updatedAt: t,
      editedAt: null,
      version: 1,
      deletedAt: null,
      tags: r() < 0.3 ? ['仕事'] : r() < 0.5 ? ['アイデア', '仕事'] : [],
      tagsVersion: 1,
      ai: null,
      image: null,
      serverSeq: i + 1,
      syncState: 'synced',
      syncError: null,
      conflict: null,
      serverVersion: 1,
    });
  }
  // 返信の親は必ずトップレベルにする
  for (const m of out) if (m.parentId && out[Number(m.parentId.slice(1))]!.parentId) m.parentId = null;
  return out;
}

const time = async (fn: () => Promise<unknown>, runs = 5) => {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    await fn();
    samples.push(performance.now() - s);
  }
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(runs / 2)]!, max: samples[runs - 1]! };
};

describe('search bench (10,000 件)', () => {
  it('500ms 以内', async () => {
    const memos = makeMemos(10_000);
    const repo = createMemoryRepository();
    const loadStart = performance.now();
    await repo.internal.write(async (tx) => {
      for (const m of memos) await tx.putMemo(m);
    });
    const load = performance.now() - loadStart;
    await repo.timeline(); // 初回ソート

    const cases: [string, () => Promise<unknown>][] = [
      ['keyword 1語（ヒット多）', () => repo.search({ keyword: 'アプリ案' })],
      ['keyword 2語 AND', () => repo.search({ keyword: 'アプリ案 振り返り' })],
      ['keyword ヒットなし（全件走査）', () => repo.search({ keyword: '存在しない語句' })],
      ['keyword ひらがな→カタカナ一致', () => repo.search({ keyword: 'こーひー' })],
      ['tags AND + author + 日付', () =>
        repo.search({ tags: ['アイデア', '仕事'], author: 'user', from: '2024-01-03T00:00:00.000Z', to: '2024-01-06T00:00:00.000Z' })],
      ['timeline 先頭30件', () => repo.timeline()],
    ];
    const rows: string[] = [];
    for (const [name, fn] of cases) {
      const r = await time(fn);
      rows.push(`| ${name} | ${r.median.toFixed(2)} | ${r.max.toFixed(2)} |`);
      expect(r.max).toBeLessThan(500);
    }
    // 1件追加後の再検索（正規化キャッシュ・再ソートの影響）
    const after = await time(async () => {
      await repo.create({ body: '追加アプリ案' });
      await repo.search({ keyword: 'アプリ案' });
    });
    rows.push(`| 1件投稿→再検索 | ${after.median.toFixed(2)} | ${after.max.toFixed(2)} |`);
    expect(after.max).toBeLessThan(500);
    console.log(
      `\n[bench] Node ${process.version} ${process.platform}/${process.arch}, 10,000 件 投入 ${load.toFixed(0)}ms\n| ケース | 中央値 ms | 最大 ms |\n| --- | --- | --- |\n${rows.join('\n')}\n`,
    );
  }, 60_000);
});
