import { describe, expect, it } from 'vitest';
import type { StoredMemo } from '../backend';
import { createMemoryRepository } from '../factories';
import { normalizeText } from '../util';

function memo(id: string, body: string, extra: Partial<StoredMemo> = {}): StoredMemo {
  return {
    id,
    parentId: null,
    author: 'user',
    body,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    editedAt: null,
    version: 1,
    deletedAt: null,
    tags: [],
    tagsVersion: null,
    ai: null,
    image: null,
    serverSeq: 1,
    syncState: 'synced',
    syncError: null,
    conflict: null,
    serverVersion: 1,
    ...extra,
  };
}

async function seeded(memos: StoredMemo[]) {
  const repo = createMemoryRepository();
  await repo.internal.write(async (tx) => {
    for (const m of memos) await tx.putMemo(m);
  });
  return repo;
}

describe('検索', () => {
  it('正規化: NFKC・大文字小文字・カタカナ/ひらがな', () => {
    expect(normalizeText('ＡＢＣ１２３ｱｲｳ')).toBe('abc123あいう');
    expect(normalizeText('カタカナ')).toBe('かたかな');
  });

  it('日本語の部分一致（単語区切りなし）と複数語 AND', async () => {
    const repo = await seeded([
      memo('1', '前に考えていたアプリ案をまとめる'),
      memo('2', '今日は雨だった'),
      memo('3', 'ＡＰＩの設計メモ'),
    ]);
    const ids = async (keyword: string) => (await repo.search({ keyword })).items.map((h) => h.memo.id);
    expect(await ids('アプリ案')).toEqual(['1']);
    expect(await ids('えていた')).toEqual(['1']);
    expect(await ids('あぷり')).toEqual(['1']);
    expect(await ids('api')).toEqual(['3']);
    expect(await ids('アプリ まとめ')).toEqual(['1']);
    expect(await ids('アプリ 雨')).toEqual([]);
  });

  it('返信本文もヒットし threadId は親', async () => {
    const repo = await seeded([memo('p', '親投稿'), memo('r', '返信で見つかる語', { parentId: 'p' })]);
    const hits = (await repo.search({ keyword: '見つかる' })).items;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.memo.id).toBe('r');
    expect(hits[0]!.threadId).toBe('p');
  });

  it('タグ AND・author・日付範囲', async () => {
    const repo = await seeded([
      memo('1', 'a', { tags: ['仕事', 'アイデア'], createdAt: '2026-03-01T00:00:00.000Z' }),
      memo('2', 'b', { tags: ['仕事'], createdAt: '2026-03-02T00:00:00.000Z' }),
      memo('3', 'c', { tags: ['仕事', 'アイデア'], author: 'ai', createdAt: '2026-03-03T00:00:00.000Z' }),
    ]);
    const ids = async (q: object) => (await repo.search(q)).items.map((h) => h.memo.id);
    expect(await ids({ tags: ['仕事', 'アイデア'] })).toEqual(['3', '1']);
    expect(await ids({ tags: ['仕事'], author: 'user' })).toEqual(['2', '1']);
    expect(await ids({ from: '2026-03-02T00:00:00.000Z', to: '2026-03-03T00:00:00.000Z' })).toEqual(['2']);
    expect(await repo.tags()).toEqual([
      { tag: '仕事', count: 3 },
      { tag: 'アイデア', count: 2 },
    ]);
  });

  it('カーソルページングで重複・欠落なし', async () => {
    const list = Array.from({ length: 95 }, (_, i) =>
      memo(`m${String(i).padStart(3, '0')}`, `共通語 ${i}`, {
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 10)).toISOString(), // 同時刻を多く含む
      }),
    );
    const repo = await seeded(list);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await repo.search({ keyword: '共通', cursor, limit: 20 });
      seen.push(...page.items.map((h) => h.memo.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(95);
    expect(new Set(seen).size).toBe(95);
  });

  it('削除済み・削除済み親の返信はヒットしない', async () => {
    const repo = await seeded([
      memo('p', '親', { deletedAt: '2026-01-02T00:00:00.000Z' }),
      memo('r', '検索語', { parentId: 'p' }),
      memo('d', '検索語', { deletedAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    expect((await repo.search({ keyword: '検索語' })).items).toHaveLength(0);
  });
  it('id に | を含んでもカーソルページングが壊れない', async () => {
    const t = '2026-01-01T00:00:00.000Z';
    const repo = await seeded([memo('a|1', '語'), memo('a|2', '語'), memo('a|3', '語')].map((m) => ({ ...m, createdAt: t })));
    const p1 = await repo.search({ keyword: '語', limit: 2 });
    const p2 = await repo.search({ keyword: '語', limit: 2, cursor: p1.nextCursor });
    expect([...p1.items, ...p2.items].map((h) => h.memo.id)).toEqual(['a|3', 'a|2', 'a|1']);
  });
});
