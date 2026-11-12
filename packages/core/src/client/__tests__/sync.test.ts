import { describe, expect, it } from 'vitest';
import { createMemoryRepository } from '../factories';
import { createSyncController } from '../sync';
import { MockServer } from './mock-server';
import { RESCUE_NOTE, applyPushResults } from '../sync-apply';
import { createApiClient } from '../api-client';

function device(server: MockServer, deviceId: string) {
  const repo = createMemoryRepository({ deviceId, connected: true });
  const sync = createSyncController(
    repo,
    { serverUrl: 'https://s.example', token: server.token, deviceId },
    server.fetch,
    { backoffBaseMs: 60_000 },
  );
  return { repo, sync };
}

const queue = (repo: ReturnType<typeof createMemoryRepository>) => repo.internal.backend.transact((tx) => tx.allOps());

describe('sync', () => {
  it('push→pull で別端末へ届き、initialImportDone が立つ', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    const b = device(server, 'B');
    expect(b.sync.status().initialImportDone).toBe(false);
    const m = await a.repo.create({ body: 'こんにちは' });
    await a.sync.syncNow();
    expect((await a.repo.get(m.id))?.syncState).toBe('synced');
    expect(a.sync.status()).toMatchObject({ pendingOps: 0, configured: true, lastError: null });
    await b.sync.syncNow();
    expect((await b.repo.get(m.id))?.body).toBe('こんにちは');
    expect(b.sync.status().initialImportDone).toBe(true);
    expect(b.sync.status().lastSyncedAt).not.toBeNull();
  });

  it('適用後に通信が切れても再送で増殖しない（opId 冪等）', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    const m = await a.repo.create({ body: 'once' });
    server.dropAfterApply = 1;
    await a.sync.syncNow();
    expect(a.sync.status().lastError).not.toBeNull();
    expect((await queue(a.repo)).length).toBe(1);
    expect((await queue(a.repo))[0]!.sending).toBe(false);
    await a.sync.syncNow();
    expect(server.memos.size).toBe(1);
    expect((await a.repo.get(m.id))?.syncState).toBe('synced');
    expect(a.sync.status().lastError).toBeNull();
    expect((await queue(a.repo)).length).toBe(0);
  });

  it('同時編集の競合で両方の本文を保持し、resolveConflict で解決する', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    const b = device(server, 'B');
    const m = await a.repo.create({ body: 'v1' });
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.repo.updateBody(m.id, 'A の編集');
    await b.repo.updateBody(m.id, 'B の編集');
    await a.sync.syncNow();
    await b.sync.syncNow();
    const bm = await b.repo.get(m.id);
    expect(bm?.syncState).toBe('conflict');
    expect(bm?.conflict?.localBody).toBe('B の編集');
    expect(bm?.conflict?.server.body).toBe('A の編集');
    expect(b.sync.status().conflicts).toBe(1);

    const resolved = await b.repo.resolveConflict(m.id, 'keep-local');
    expect(resolved.body).toBe('B の編集');
    expect(resolved.conflict).toBeNull();
    const q = await queue(b.repo);
    expect(q[0]).toMatchObject({ baseVersion: 2, memo: { version: 3 } });
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect((await a.repo.get(m.id))?.body).toBe('B の編集');
    expect(server.memos.get(m.id)?.version).toBe(3);
    expect(b.sync.status().conflicts).toBe(0);
  });

  it('keep-server と任意本文での解決', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    const b = device(server, 'B');
    const m = await a.repo.create({ body: 'v1' });
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.repo.updateBody(m.id, 'server');
    await a.sync.syncNow();
    await b.repo.updateBody(m.id, 'local');
    await b.sync.syncNow();
    const kept = await b.repo.resolveConflict(m.id, 'keep-server');
    expect(kept.body).toBe('server');
    expect((await queue(b.repo)).length).toBe(0);

    await a.repo.updateBody(m.id, 'server2');
    await a.sync.syncNow();
    await b.repo.updateBody(m.id, 'local2');
    await b.sync.syncNow();
    const merged = await b.repo.resolveConflict(m.id, { body: 'server2 + local2' });
    expect(merged.body).toBe('server2 + local2');
    await b.sync.syncNow();
    expect(server.memos.get(m.id)?.body).toBe('server2 + local2');
  });

  it('削除済み（tombstone）は再送や pull で復活しない', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    const b = device(server, 'B');
    const p = await a.repo.create({ body: 'parent' });
    const r = await a.repo.create({ body: 'reply', parentId: p.id });
    await a.sync.syncNow();
    await b.sync.syncNow();
    // B がオフラインで編集、A が削除
    await b.repo.updateBody(p.id, 'B 編集');
    await a.repo.remove(p.id);
    await a.sync.syncNow();
    expect(server.memos.get(r.id)?.deletedAt).not.toBeNull();
    await b.sync.syncNow();
    await b.sync.syncNow();
    expect(await b.repo.get(p.id)).toBeNull();
    expect(await b.repo.get(r.id)).toBeNull();
    expect((await queue(b.repo)).length).toBe(0);
    expect(server.memos.get(p.id)?.deletedAt).not.toBeNull();
    // B の未送信の編集は新しいメモとして残り、サーバーへも届く
    const rescued = [...server.memos.values()].filter((m) => m.body.includes('B 編集'));
    expect(rescued).toHaveLength(1);
    expect(rescued[0]!.id).not.toBe(p.id);
    expect(rescued[0]!.body.startsWith(RESCUE_NOTE)).toBe(true);
    expect(rescued[0]!.deletedAt).toBeNull();
    // 削除後の同期済み undo は不可
    await expect(a.repo.undoRemove(p.id)).rejects.toMatchObject({ code: 'cannot_undo' });
  });

  it('pull で届いた削除でも、未送信の返信・編集を無言で失わない（ローカル削除は救出しない）', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    const b = device(server, 'B');
    const p = await a.repo.create({ body: 'parent' });
    const q = await a.repo.create({ body: 'other' });
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.repo.remove(p.id);
    await a.sync.syncNow();
    // B: 削除済みの親への新しい返信（未送信）と、自分で削除したメモ
    await b.repo.create({ body: 'B の返信', parentId: p.id });
    await b.repo.updateBody(q.id, 'B が編集後に削除');
    await b.repo.remove(q.id);
    // pull を先に適用させるため push を経ずに変更を取り込む
    await b.repo.internal.backend.transact(async (tx) => {
      const { applyPulledChanges } = await import('../sync-apply');
      await applyPulledChanges(tx, [server.memos.get(p.id)!], 'B');
    });
    await b.sync.syncNow();
    const bodies = [...server.memos.values()].filter((m) => !m.deletedAt).map((m) => m.body);
    expect(bodies.some((x) => x.includes('B の返信'))).toBe(true);
    expect(bodies.some((x) => x.includes('B が編集後に削除'))).toBe(false);
    const rescued = [...server.memos.values()].find((m) => m.body.includes('B の返信'))!;
    expect(rescued.parentId).toBeNull();
  });

  it('同期前の削除→undo はサーバーへ削除を送らない', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    const m = await a.repo.create({ body: 'x' });
    await a.sync.syncNow();
    await a.repo.remove(m.id);
    await a.repo.undoRemove(m.id);
    await a.sync.syncNow();
    expect(server.memos.get(m.id)?.deletedAt).toBeNull();
    expect((await a.repo.get(m.id))?.syncState).toBe('synced');
  });

  it('pull は未送信 op のあるメモの本文を上書きせず、タグ更新は version を変えない', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    const m = await a.repo.create({ body: 'v1' });
    await a.sync.syncNow();
    server.serverEdit(m.id, { tags: ['アイデア'], tagsVersion: 1 });
    await a.repo.updateBody(m.id, 'ローカル編集');
    // push を失敗させ、pull のみ動いた状況を再現
    await a.repo.internal.write(async (tx) => {
      const { applyPulledChanges } = await import('../sync-apply');
      await applyPulledChanges(tx, [server.memos.get(m.id)!], 'A');
    });
    const local = await a.repo.get(m.id);
    expect(local?.body).toBe('ローカル編集');
    expect(local?.tags).toEqual(['アイデア']);
    expect(local?.version).toBe(2);
    await a.sync.syncNow();
    const after = await a.repo.get(m.id);
    expect(after?.body).toBe('ローカル編集');
    expect(after?.version).toBe(2);
    expect(after?.tags).toEqual(['アイデア']);
    expect((await a.repo.tags())[0]).toEqual({ tag: 'アイデア', count: 1 });
  });

  it('送信中の編集は次の op として積まれ、失われない', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    const m = await a.repo.create({ body: 'v1' });
    const orig = server.fetch;
    let edited = false;
    server.fetch = async (input, init) => {
      if (!edited && input.includes('/push')) {
        edited = true;
        await a.repo.updateBody(m.id, 'v2（送信中に編集）');
      }
      return orig(input, init);
    };
    const s2 = createSyncController(a.repo, { serverUrl: 'https://s.example', token: 'tok', deviceId: 'A' }, (i, n) =>
      server.fetch(i, n),
    );
    await s2.syncNow();
    expect(server.memos.get(m.id)?.body).toBe('v2（送信中に編集）');
    expect(server.memos.get(m.id)?.version).toBe(2);
    expect((await a.repo.get(m.id))?.syncState).toBe('synced');
  });

  it('一時的な rejected（contention_retry_later）は op を残して後で再送', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    const m = await a.repo.create({ body: 'x' });
    server.contention = 1;
    await a.sync.syncNow();
    expect(server.pushCalls).toHaveLength(1);
    expect((await queue(a.repo))).toHaveLength(1);
    expect(a.sync.status().nextRetryAt).not.toBeNull();
    expect((await a.repo.get(m.id))?.syncState).toBe('pending');
    await a.sync.syncNow();
    expect(server.memos.has(m.id)).toBe(true);
    expect(a.sync.status().lastError).toBeNull();
    a.sync.stop();
  });

  it('恒久的な rejected は error 状態にしてキューから外す', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    const r = await a.repo.internal.write(async (tx) => {
      const { enqueueUpsert } = await import('../ops');
      const t = new Date().toISOString();
      return enqueueUpsert(
        tx,
        {
          id: 'orphan', parentId: 'missing', author: 'user', body: 'x', createdAt: t, updatedAt: t, editedAt: null,
          version: 1, deletedAt: null, tags: [], tagsVersion: null, ai: null, image: null, serverSeq: null,
          syncState: 'pending', syncError: null, conflict: null, serverVersion: 0,
        },
        true,
      );
    });
    await a.sync.syncNow();
    expect((await a.repo.get(r.id))?.syncState).toBe('error');
    expect((await a.repo.get(r.id))?.syncError).toBe('parent_not_found');
    expect(await queue(a.repo)).toHaveLength(0);
  });

  it('100 件ずつ push する', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    for (let i = 0; i < 230; i++) await a.repo.create({ body: `m${i}` });
    await a.sync.syncNow();
    expect(server.pushCalls.map((c) => c.length)).toEqual([100, 100, 30]);
    expect(server.memos.size).toBe(230);
    expect(a.sync.status().pendingOps).toBe(0);
  });

  it('pull は hasMore の間ページングする', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    for (let i = 0; i < 1203; i++) await a.repo.create({ body: `m${i}` });
    await a.sync.syncNow();
    const b = device(server, 'B');
    await b.sync.syncNow();
    expect((await b.repo.search({ keyword: 'm', limit: 500 })).items.length).toBe(500);
    expect((await b.repo.timeline(null, 2000)).items.length).toBe(500);
    expect(await b.repo.internal.backend.getMeta('syncCursor')).toBe(server.seq);
  }, 30_000); // 1,203 件を作って同期する量のテスト。CI の遅い環境でも収まるよう長めにする

  it('401 は認証切れ状態にし、ローカルデータは消さない。updateConnection で再開', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    const m = await a.repo.create({ body: 'keep me' });
    server.token = 'rotated';
    await a.sync.syncNow();
    expect(a.sync.status().authRequired).toBe(true);
    expect(a.sync.status().lastError).toMatch(/再ログイン/);
    expect((await a.repo.get(m.id))?.body).toBe('keep me');
    expect(a.sync.status().pendingOps).toBe(1);
    a.sync.updateConnection({ token: 'rotated' });
    await a.sync.syncNow();
    expect(a.sync.status().authRequired).toBe(false);
    expect(server.memos.has(m.id)).toBe(true);
  });

  it('多重起動は1本にまとまる', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    await a.repo.create({ body: 'x' });
    let pulls = 0;
    const orig = server.fetch;
    server.fetch = (i, n) => {
      if (i.includes('/pull')) pulls++;
      return orig(i, n);
    };
    await Promise.all([a.sync.syncNow(), a.sync.syncNow(), a.sync.syncNow()]);
    expect(pulls).toBeLessThanOrEqual(2);
    expect(server.pushCalls.length).toBe(1);
  });

  it('オフライン時は失敗状態とバックオフ予約、ローカル保存は成功', async () => {
    const server = new MockServer();
    server.offline = true;
    const a = device(server, 'A');
    const m = await a.repo.create({ body: 'offline' });
    expect(m.syncState).toBe('pending');
    await a.sync.syncNow();
    const st = a.sync.status();
    expect(st.lastError).toBe('サーバーに接続できません');
    expect(st.nextRetryAt).not.toBeNull();
    a.sync.stop();
  });

  it('返信と AI 投稿が届く。他端末で作成された返信の親削除も反映', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    const p = await a.repo.create({ body: 'p' });
    await a.sync.syncNow();
    const t = new Date().toISOString();
    server.serverEdit('ai-1', {
      id: 'ai-1',
      parentId: null,
      author: 'ai',
      body: 'AI 提案',
      createdAt: t,
      updatedAt: t,
      editedAt: null,
      version: 1,
      deletedAt: null,
      tags: [],
      tagsVersion: null,
      ai: { kind: 'action', sourceIds: [p.id], sourceVersions: [1], model: 'm', jobId: 'j' },
      image: null,
    });
    const events: string[] = [];
    a.repo.subscribe((e) => e.type === 'memo-changed' && e.origin === 'remote' && events.push(...e.ids));
    await a.sync.syncNow();
    expect((await a.repo.get('ai-1'))?.author).toBe('ai');
    expect(events).toContain('ai-1');
    expect((await a.repo.search({ author: 'ai' })).items.map((h) => h.memo.id)).toEqual(['ai-1']);
  });
  it('画像のみの op が競合しても、後続の本文編集を競合として保持する（無言で失わない）', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    const b = device(server, 'B');
    const m = await a.repo.create({ body: 'v1', image: new Blob([new Uint8Array([1])], { type: 'image/png' }) });
    await a.sync.syncNow();
    await b.sync.syncNow();
    await b.repo.updateBody(m.id, 'B の編集');
    await b.sync.syncNow();
    // A: 画像のみの op が送信中の間に本文を編集 → 別 op になる
    await a.repo.cancelImageSummary(m.id);
    await a.repo.internal.backend.transact(async (tx) => {
      for (const o of await tx.allOps()) await tx.putOp({ ...o, sending: true });
    });
    await a.repo.updateBody(m.id, 'A の編集');
    expect(await queue(a.repo)).toHaveLength(2);
    await a.sync.syncNow();
    const am = await a.repo.get(m.id);
    expect(am?.syncState).toBe('conflict');
    expect(am?.conflict?.localBody).toBe('A の編集');
    expect(am?.conflict?.server.body).toBe('B の編集');
  });

  it('push 結果に別 ID のメモが返っても他のメモを上書きしない', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    const x = await a.repo.create({ body: 'x' });
    const y = await a.repo.create({ body: 'y' });
    const [opX] = (await queue(a.repo)).filter((o) => o.memoId === x.id);
    const evil = { ...(await a.repo.get(y.id))!, body: 'evil', version: 9, serverSeq: 1 };
    await a.repo.internal.write((tx) =>
      applyPushResults(tx, [opX!], [{ opId: opX!.opId, status: 'applied', memo: evil }], 'A'),
    );
    expect((await a.repo.get(y.id))?.body).toBe('y');
    expect((await a.repo.get(x.id))?.syncState).toBe('synced');
  });

  it('pull の壊れた変更は読み飛ばし、同期を止めない', async () => {
    const server = new MockServer();
    const a = device(server, 'A');
    const b = device(server, 'B');
    const m = await a.repo.create({ body: 'ok' });
    await a.sync.syncNow();
    server.memos.set('broken', { id: 42, serverSeq: ++server.seq } as never);
    await b.sync.syncNow();
    expect(b.sync.status().lastError).toBeNull();
    expect((await b.repo.get(m.id))?.body).toBe('ok');
  });

  it('stop() 後は失敗しても再試行を予約しない', async () => {
    const server = new MockServer();
    server.offline = true;
    const a = device(server, 'A');
    await a.repo.create({ body: 'x' });
    a.sync.stop();
    await a.sync.syncNow();
    expect(a.sync.status().lastError).toBe('サーバーに接続できません');
    expect(a.sync.status().nextRetryAt).toBeNull();
  });

  it('不正な retryAfterSec は無視し、pull のクエリはエンコードする', async () => {
    const urls: string[] = [];
    const api = createApiClient('https://s.example', 't', async (input) => {
      urls.push(input);
      return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'x', retryAfterSec: -5 } }), {
        status: 429,
      });
    });
    const err = await api.health().catch((e) => e);
    expect(err.retryAfterSec).toBeNull();
    await api.pull('1&x=y' as unknown as number).catch(() => undefined);
    expect(urls[1]).toBe('https://s.example/api/sync/pull?since=1%26x%3Dy&limit=500');
  });
});
