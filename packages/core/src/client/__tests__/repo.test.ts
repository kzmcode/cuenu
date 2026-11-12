import { describe, expect, it } from 'vitest';
import { createMemoryRepository } from '../factories';
import { RepoError } from '../util';

const ops = (repo: ReturnType<typeof createMemoryRepository>) =>
  repo.internal.backend.transact((tx) => tx.allOps());

describe('memory repository', () => {
  it('空白のみの投稿・編集を拒否する', async () => {
    const repo = createMemoryRepository();
    await expect(repo.create({ body: '  \n\t　' })).rejects.toBeInstanceOf(RepoError);
    const m = await repo.create({ body: 'a' });
    await expect(repo.updateBody(m.id, '   ')).rejects.toMatchObject({ code: 'empty_body' });
    expect((await ops(repo)).length).toBe(1);
  });

  it('作成でメモとキューを1件ずつ保存し、未送信の編集は新規opに圧縮する', async () => {
    const repo = createMemoryRepository();
    const m = await repo.create({ body: 'first' });
    expect(m.syncState).toBe('pending');
    expect(m.version).toBe(1);
    const e = await repo.updateBody(m.id, 'second');
    expect(e.version).toBe(1);
    expect(e.editedAt).not.toBeNull();
    expect(e.createdAt).toBe(m.createdAt);
    const q = await ops(repo);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ kind: 'upsert', baseVersion: 0, memo: { body: 'second', version: 1 } });
    expect(repo.syncStatus().pendingOps).toBe(1);
  });

  it('返信はタイムラインに混入せず、返信への返信はスレッド直下に付く', async () => {
    const repo = createMemoryRepository();
    const p = await repo.create({ body: 'parent' });
    const r1 = await repo.create({ body: 'r1', parentId: p.id });
    const r2 = await repo.create({ body: 'r2', parentId: r1.id });
    expect(r2.parentId).toBe(p.id);
    const tl = await repo.timeline();
    expect(tl.items.map((m) => m.id)).toEqual([p.id]);
    expect(tl.items[0]!.replyCount).toBe(2);
    expect((await repo.replies(p.id)).map((m) => m.body)).toEqual(['r1', 'r2']);
  });

  it('タイムラインは新しい順でカーソルページングできる', async () => {
    const repo = createMemoryRepository();
    for (let i = 0; i < 7; i++) await repo.create({ body: `m${i}` });
    const p1 = await repo.timeline(null, 3);
    const p2 = await repo.timeline(p1.nextCursor, 3);
    const p3 = await repo.timeline(p2.nextCursor, 3);
    const all = [...p1.items, ...p2.items, ...p3.items].map((m) => m.body);
    expect(all).toHaveLength(7);
    expect(new Set(all).size).toBe(7);
    expect(p3.nextCursor).toBeNull();
    // 新しい順
    const created = [...p1.items, ...p2.items, ...p3.items].map((m) => m.createdAt + m.id);
    expect([...created].sort().reverse()).toEqual(created);
  });

  it('親削除で返信も消え、undoRemove で復元できる', async () => {
    const repo = createMemoryRepository();
    const p = await repo.create({ body: 'parent' });
    const r = await repo.create({ body: 'reply', parentId: p.id });
    await repo.remove(p.id);
    expect(await repo.get(p.id)).toBeNull();
    expect(await repo.get(r.id)).toBeNull();
    expect((await repo.timeline()).items).toHaveLength(0);
    expect((await repo.search({ keyword: 'reply' })).items).toHaveLength(0);
    await expect(repo.updateBody(p.id, 'x')).rejects.toMatchObject({ code: 'deleted' });
    await repo.undoRemove(p.id);
    expect((await repo.get(p.id))?.body).toBe('parent');
    expect((await repo.get(r.id))?.body).toBe('reply');
    const q = await ops(repo);
    expect(q.every((o) => o.kind === 'upsert')).toBe(true);
  });

  it('個別に先に消した返信は親の undo で復活しない', async () => {
    const repo = createMemoryRepository();
    const p = await repo.create({ body: 'parent' });
    const r = await repo.create({ body: 'reply', parentId: p.id });
    await repo.remove(r.id);
    await new Promise((res) => setTimeout(res, 2));
    await repo.remove(p.id);
    await repo.undoRemove(p.id);
    expect(await repo.get(r.id)).toBeNull();
  });

  it('下書きの保存・取得・削除', async () => {
    const repo = createMemoryRepository();
    await repo.setDraft('quick', '書きかけ');
    expect((await repo.getDraft('quick'))?.body).toBe('書きかけ');
    await repo.clearDraft('quick');
    expect(await repo.getDraft('quick')).toBeNull();
  });

  it('エクスポートとインポート（重複は取り込まない）', async () => {
    const a = createMemoryRepository();
    const p = await a.create({ body: 'parent' });
    await a.create({ body: 'reply', parentId: p.id });
    const gone = await a.create({ body: 'gone' });
    await a.remove(gone.id);
    const bundle = await a.exportAll();
    expect(bundle.memos).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(bundle)).memos[0]).not.toHaveProperty('syncState');

    const b = createMemoryRepository();
    expect(await b.importBundle(bundle)).toEqual({ imported: 2 });
    expect(await b.importBundle(bundle)).toEqual({ imported: 0 });
    expect((await b.replies(p.id))[0]?.body).toBe('reply');
    await expect(b.importBundle({ app: 'x' } as never)).rejects.toMatchObject({ code: 'invalid_bundle' });
  });

  it('AI 投稿のいいねは版を変えずに送信キューへ積み、ユーザーのメモには付けられない', async () => {
    const repo = createMemoryRepository();
    const t = new Date().toISOString();
    await repo.internal.write((tx) =>
      tx.putMemo({
        id: 'ai2', parentId: null, author: 'ai', body: 'AI', createdAt: t, updatedAt: t, editedAt: null, version: 1,
        deletedAt: null, tags: [], tagsVersion: null, ai: null, image: null, serverSeq: 1,
        syncState: 'synced', syncError: null, conflict: null, serverVersion: 1,
      }),
    );
    const m = await repo.setLiked('ai2', true);
    expect(m.liked).toBe(true);
    expect(m.version).toBe(1);
    const ops = await repo.internal.backend.transact((tx) => tx.allOps());
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'upsert', baseVersion: 1, memo: { version: 1, body: 'AI', liked: true } });
    // 取り消しは同じ未送信 op にまとめる
    await repo.setLiked('ai2', false);
    const ops2 = await repo.internal.backend.transact((tx) => tx.allOps());
    expect(ops2).toHaveLength(1);
    expect(ops2[0]?.memo?.liked).toBe(false);
    const u = await repo.create({ body: '自分のメモ' });
    await expect(repo.setLiked(u.id, true)).rejects.toMatchObject({ code: 'readonly' });
  });

  it('AI 投稿の本文は編集できない', async () => {
    const repo = createMemoryRepository();
    await repo.internal.write((tx) =>
      tx.putMemo({
        id: 'ai1',
        parentId: null,
        author: 'ai',
        body: 'AI',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
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
      }),
    );
    await expect(repo.updateBody('ai1', 'x')).rejects.toMatchObject({ code: 'readonly' });
    await repo.create({ body: 'AIへの返信', parentId: 'ai1' });
    expect((await repo.get('ai1'))?.replyCount).toBe(1);
  });

  it('memo-changed を通知する', async () => {
    const repo = createMemoryRepository();
    const events: string[] = [];
    const off = repo.subscribe((e) => events.push(e.type));
    await repo.create({ body: 'x' });
    off();
    expect(events).toContain('memo-changed');
    expect(events).toContain('sync-status');
  });
});
