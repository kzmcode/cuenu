import type { MemoWithMeta, RepoEvent, SyncStatus } from '@cuenu/core';
import { describe, expect, it, vi } from 'vitest';
import { createSeenStore, notificationText, startAiNotifier } from './notifier';

const memo = (id: string, p: Partial<MemoWithMeta> = {}): MemoWithMeta => ({
  id,
  parentId: null,
  author: 'ai',
  body: `本文 ${id}`,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
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
  replyCount: 0,
  ...p,
});

function setup(memos: MemoWithMeta[], opts: { imported?: boolean; enabled?: boolean } = {}) {
  let listener: ((e: RepoEvent) => void) | null = null;
  const store = new Map(memos.map((m) => [m.id, m]));
  const notify = vi.fn();
  const storage = new Map<string, string>();
  const seen = createSeenStore('env-test', { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) });
  const status = { initialImportDone: opts.imported ?? true } as SyncStatus;
  const stop = startAiNotifier({
    repo: {
      get: async (id) => store.get(id) ?? null,
      subscribe: (l) => {
        listener = l;
        return () => (listener = null);
      },
    },
    syncStatus: () => status,
    isEnabled: () => opts.enabled ?? true,
    notify,
    seen,
  });
  const emit = async (ids: string[], origin: 'local' | 'remote' = 'remote') => {
    listener?.({ type: 'memo-changed', ids, origin });
    await new Promise((r) => setTimeout(r, 0));
  };
  return { emit, notify, stop, status, storage };
}

describe('startAiNotifier', () => {
  it('AI のトップレベル新着だけを1回通知する', async () => {
    const t = setup([memo('a1'), memo('u1', { author: 'user' }), memo('r1', { parentId: 'a1' }), memo('d1', { deletedAt: 'x' })]);
    await t.emit(['a1', 'u1', 'r1', 'd1']);
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify).toHaveBeenCalledWith('Cuenu', '新しいAIの提案があります');
    await t.emit(['a1']); // タグ更新などで再度届いても重複しない
    expect(t.notify).toHaveBeenCalledTimes(1);
  });

  it('複数件はまとめて通知', async () => {
    const t = setup([memo('a1'), memo('a2')]);
    await t.emit(['a1', 'a2']);
    expect(t.notify).toHaveBeenCalledWith('Cuenu', '新しいAIの提案が 2 件あります');
  });

  it('local 起点・初回取り込み中・無効時は通知しない（既読扱い）', async () => {
    const t = setup([memo('a1'), memo('a2')], { imported: false });
    await t.emit(['a1'], 'local');
    await t.emit(['a1']);
    expect(t.notify).not.toHaveBeenCalled();
    t.status.initialImportDone = true;
    await t.emit(['a1']);
    expect(t.notify).not.toHaveBeenCalled();
    const off = setup([memo('b1')], { enabled: false });
    await off.emit(['b1']);
    expect(off.notify).not.toHaveBeenCalled();
  });

  it('通知済み ID を永続化する', async () => {
    const t = setup([memo('a1')]);
    await t.emit(['a1']);
    expect(JSON.parse(t.storage.get('cuenu.desktop.notified.env-test')!)).toEqual(['a1']);
  });
});

describe('notificationText', () => {
  it('既定では本文を出さない', () => {
    expect(notificationText([memo('a')], false).body).toBe('新しいAIの提案があります');
    expect(notificationText([memo('a', { body: 'x'.repeat(100) })], true).body).toHaveLength(81);
  });
});
