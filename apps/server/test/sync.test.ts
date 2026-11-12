import type { Memo, PushOp, SyncMemoPayload } from '@cuenu/core';
import { beforeEach, describe, expect, test } from 'vitest';
import { pull, push } from '../src/sync';
import { makeCtx, type TestCtx } from './helpers';

const T0 = '2026-11-04T01:00:00.000Z';
let n = 0;
const opId = () => `op-${++n}`;

function payload(id: string, body: string, version = 1, extra: Partial<SyncMemoPayload> = {}): SyncMemoPayload {
  return { id, parentId: null, body, createdAt: T0, editedAt: null, version, image: null, ...extra };
}
const upsert = (memo: SyncMemoPayload, baseVersion: number, id = opId()): PushOp => ({
  opId: id,
  memoId: memo.id,
  kind: 'upsert',
  baseVersion,
  memo,
});
const del = (memoId: string, baseVersion: number, id = opId()): PushOp => ({ opId: id, memoId, kind: 'delete', baseVersion, memo: null });

let ctx: TestCtx;
beforeEach(() => {
  ctx = makeCtx();
});
const one = async (op: PushOp, dev = 'dev-a') => (await push(ctx, dev, { deviceId: dev, ops: [op] })).results[0]!;

describe('sync push', () => {
  test('create then resend same opId is duplicate (no duplication)', async () => {
    const op = upsert(payload('m1', 'hello'), 0);
    const a = await one(op);
    expect(a.status).toBe('applied');
    expect(a.memo).toMatchObject({ id: 'm1', body: 'hello', version: 1, author: 'user' });
    const b = await one(op);
    expect(b.status).toBe('duplicate');
    expect(b.memo?.id).toBe('m1');
    const p = await pull(ctx, 0, 100);
    expect(p.changes).toHaveLength(1);
  });

  test('new with existing id and different opId is conflict', async () => {
    await one(upsert(payload('m1', 'a'), 0));
    const r = await one(upsert(payload('m1', 'b'), 0));
    expect(r.status).toBe('conflict');
    expect(r.memo?.body).toBe('a');
  });

  test('edit with correct baseVersion bumps version; stale base is conflict', async () => {
    await one(upsert(payload('m1', 'v1'), 0));
    const a = await one(upsert(payload('m1', 'v2 from A', 2, { editedAt: T0 }), 1), 'dev-a');
    expect(a.status).toBe('applied');
    expect(a.memo?.version).toBe(2);
    const b = await one(upsert(payload('m1', 'v2 from B', 2), 1), 'dev-b');
    expect(b.status).toBe('conflict');
    expect(b.memo?.body).toBe('v2 from A'); // サーバー版を返す（無言で消さない）
  });

  test('payload.version must be baseVersion+1', async () => {
    await one(upsert(payload('m1', 'v1'), 0));
    const r = await one(upsert(payload('m1', 'x', 5), 1));
    expect(r.status).toBe('rejected');
  });

  test('image-only update keeps version', async () => {
    await one(upsert(payload('m1', 'img memo'), 0));
    const image = { status: 'done' as const, originDeviceId: 'dev-a', summary: '猫の写真', applied: false, error: null, baseVersion: 1 };
    const r = await one(upsert(payload('m1', 'img memo', 1, { image }), 1));
    expect(r.status).toBe('applied');
    expect(r.memo?.version).toBe(1);
    expect(r.memo?.image?.summary).toBe('猫の写真');
  });

  test('delete creates tombstone, upsert after delete is gone, parent delete cascades replies', async () => {
    await one(upsert(payload('p', 'parent'), 0));
    await one(upsert(payload('r1', 'reply1', 1, { parentId: 'p' }), 0));
    await one(upsert(payload('r2', 'reply2', 1, { parentId: 'p' }), 0));
    const d = await one(del('p', 1));
    expect(d.status).toBe('applied');
    expect(d.memo?.deletedAt).toBeTruthy();
    expect(d.memo?.body).toBe('');
    const p = await pull(ctx, 0, 100);
    const byId = new Map(p.changes.map((m) => [m.id, m]));
    expect(byId.get('r1')?.deletedAt).toBeTruthy();
    expect(byId.get('r2')?.deletedAt).toBeTruthy();
    // 再送された古い編集で復活しない
    const g = await one(upsert(payload('p', 'resurrect', 2), 1));
    expect(g.status).toBe('gone');
    expect(g.memo?.deletedAt).toBeTruthy();
    // 削除済みの親への新規返信も gone
    const r3 = await one(upsert(payload('r3', 'late reply', 1, { parentId: 'p' }), 0));
    expect(r3.status).toBe('gone');
    // 再削除も gone
    expect((await one(del('p', 1))).status).toBe('gone');
  });

  test('delete of never-synced memo leaves tombstone so a late create is gone', async () => {
    expect((await one(del('ghost', 0))).status).toBe('applied');
    expect((await one(upsert(payload('ghost', 'late'), 0))).status).toBe('gone');
  });

  test('reply validation', async () => {
    expect((await one(upsert(payload('r', 'x', 1, { parentId: 'nope' }), 0))).message).toBe('parent_not_found');
    await one(upsert(payload('p', 'parent'), 0));
    await one(upsert(payload('r', 'reply', 1, { parentId: 'p' }), 0));
    expect((await one(upsert(payload('rr', 'x', 1, { parentId: 'r' }), 0))).message).toBe('parent_is_reply');
  });

  test('AI memo body is read-only but deletable', async () => {
    ctx.db.raw.exec(`UPDATE counters SET value = value + 1 WHERE name='seq'`);
    ctx.db.raw
      .prepare(
        `INSERT INTO memos (id, parent_id, author, body, created_at, updated_at, version, tags, server_seq) VALUES ('ai1', NULL, 'ai', 'suggest', ?, ?, 1, '[]', 1)`,
      )
      .run(T0, T0);
    const r = await one(upsert(payload('ai1', 'hacked', 2), 1));
    expect(r.status).toBe('rejected');
    expect(r.memo?.body).toBe('suggest');
    expect((await one(del('ai1', 1))).status).toBe('applied');
  });

  test('invalid ops are rejected individually; >100 ops is 400', async () => {
    const res = await push(ctx, 'd', {
      deviceId: 'd',
      ops: [{ opId: 'x', memoId: 'm', kind: 'upsert', baseVersion: 0, memo: null }, upsert(payload('ok', 'fine'), 0)],
    });
    expect(res.results.map((r) => r.status)).toEqual(['rejected', 'applied']);
    const many = Array.from({ length: 101 }, (_, i) => upsert(payload(`m${i}`, 'x'), 0));
    await expect(push(ctx, 'd', { deviceId: 'd', ops: many })).rejects.toMatchObject({ status: 400 });
  });
});

describe('sync races', () => {
  test('parent delete retries when a reply is created after the replies were listed', async () => {
    await one(upsert(payload('p', 'parent'), 0));
    const all = ctx.db.all.bind(ctx.db);
    let injected = false;
    ctx.db.all = async <T,>(sql: string, ...params: unknown[]) => {
      const r = await all<T>(sql, ...params);
      if (!injected && sql.includes('WHERE parent_id = ? AND deleted_at IS NULL')) {
        injected = true; // 列挙の直後に別端末の返信が届いた
        await one(upsert(payload('late', 'late reply', 1, { parentId: 'p' }), 0), 'dev-b');
      }
      return r;
    };
    const d = await one(del('p', 1));
    expect(d.status).toBe('applied');
    const late = (await pull(ctx, 0, 100)).changes.find((m) => m.id === 'late');
    expect(late?.deletedAt).toBeTruthy();
  });

  test('reply create is gone when the parent is deleted after the parent check', async () => {
    await one(upsert(payload('p', 'parent'), 0));
    const first = ctx.db.first.bind(ctx.db);
    let injected = false;
    ctx.db.first = async <T,>(sql: string, ...params: unknown[]) => {
      const r = await first<T>(sql, ...params);
      if (!injected && sql === 'SELECT * FROM memos WHERE id = ?' && params[0] === 'p') {
        injected = true; // 親を確認した直後に親が削除された
        ctx.db.raw.prepare(`UPDATE memos SET deleted_at = ? WHERE id = 'p'`).run(T0);
      }
      return r;
    };
    const r = await one(upsert(payload('r', 'reply', 1, { parentId: 'p' }), 0));
    expect(r.status).toBe('gone');
    expect(r.memo?.deletedAt).toBeTruthy();
  });

  test('delete of never-synced memo ignores a malformed parentId', async () => {
    const op = { ...del('ghost2', 0), memo: { parentId: { x: 1 } } } as unknown as PushOp;
    const r = await one(op);
    expect(r.status).toBe('applied');
    expect(r.memo?.parentId).toBeNull();
  });
});

describe('sync pull', () => {
  test('returns changes in serverSeq order with pagination and unique seqs', async () => {
    for (let i = 0; i < 5; i++) await one(upsert(payload(`m${i}`, `b${i}`), 0));
    await one(upsert(payload('m0', 'edited', 2), 1));
    const all: Memo[] = [];
    let since = 0;
    for (;;) {
      const p = await pull(ctx, since, 2);
      all.push(...p.changes);
      since = p.nextSince;
      if (!p.hasMore) break;
    }
    const seqs = all.map((m) => m.serverSeq!);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(all.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm0']);
    expect((await push(ctx, 'd', { deviceId: 'd', ops: [] })).serverSeq).toBe(since);
    expect((await pull(ctx, since, 10)).changes).toHaveLength(0);
  });
});
