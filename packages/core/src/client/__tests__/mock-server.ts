// api.ts の競合規則に沿ったテスト用インメモリサーバー（fetch 互換）。
import type { PushOp, PushResult } from '../../api';
import type { Memo } from '../../types';
import type { FetchLike } from '../api-client';

export class MockServer {
  memos = new Map<string, Memo>();
  applied = new Map<string, string>(); // opId -> memoId
  seq = 0;
  token = 'tok';
  pushCalls: PushOp[][] = [];
  summarizeCalls: string[] = [];
  /** summarize の応答を差し替え */
  summarize: (memoId: string) => Response | { summary: string } = () => ({ summary: '画像の要約' });
  /** push を適用した直後に通信断にする回数 */
  dropAfterApply = 0;
  offline = false;
  /** 次の N 件の op を contention_retry_later で拒否する */
  contention = 0;

  private bump(m: Memo) {
    m.serverSeq = ++this.seq;
    this.memos.set(m.id, m);
  }

  /** サーバー側（AI 等）による変更 */
  serverEdit(id: string, patch: Partial<Memo>) {
    const m = { ...this.memos.get(id)!, ...patch };
    this.bump(m);
  }

  private apply(op: PushOp): PushResult {
    const cur = this.memos.get(op.memoId);
    const dupId = this.applied.get(op.opId);
    if (dupId) return { opId: op.opId, status: 'duplicate', memo: this.memos.get(dupId) ?? null };
    if (op.kind === 'delete') {
      if (!cur) return { opId: op.opId, status: 'rejected', memo: null, message: 'not_found' };
      const t = new Date().toISOString();
      if (!cur.deletedAt) {
        this.bump({ ...cur, deletedAt: t, updatedAt: t });
        for (const c of this.memos.values()) {
          if (c.parentId === cur.id && !c.deletedAt) this.bump({ ...c, deletedAt: t, updatedAt: t });
        }
      }
      this.applied.set(op.opId, op.memoId);
      return { opId: op.opId, status: 'applied', memo: this.memos.get(op.memoId)! };
    }
    const p = op.memo!;
    if (cur?.deletedAt) return { opId: op.opId, status: 'gone', memo: cur };
    if (p.parentId) {
      const parent = this.memos.get(p.parentId);
      if (!parent) return { opId: op.opId, status: 'rejected', memo: null, message: 'parent_not_found' };
      if (parent.deletedAt) return { opId: op.opId, status: 'gone', memo: parent };
    }
    if (op.baseVersion === 0) {
      if (cur) return { opId: op.opId, status: 'conflict', memo: cur };
      const t = new Date().toISOString();
      const m: Memo = {
        id: p.id,
        parentId: p.parentId,
        author: 'user',
        body: p.body,
        createdAt: p.createdAt,
        updatedAt: t,
        editedAt: p.editedAt,
        version: 1,
        deletedAt: null,
        tags: [],
        tagsVersion: null,
        ai: null,
        image: p.image,
        serverSeq: null,
      };
      this.bump(m);
      this.applied.set(op.opId, m.id);
      return { opId: op.opId, status: 'applied', memo: m };
    }
    if (!cur || cur.version !== op.baseVersion) {
      return { opId: op.opId, status: 'conflict', memo: cur ?? null };
    }
    if (p.version === cur.version) {
      if (p.body !== cur.body) return { opId: op.opId, status: 'rejected', memo: cur, message: 'version' };
      this.bump({ ...cur, image: p.image, updatedAt: new Date().toISOString() });
    } else {
      this.bump({
        ...cur,
        body: p.body,
        editedAt: p.editedAt,
        version: cur.version + 1,
        image: p.image,
        updatedAt: new Date().toISOString(),
      });
    }
    this.applied.set(op.opId, op.memoId);
    return { opId: op.opId, status: 'applied', memo: this.memos.get(op.memoId)! };
  }

  fetch: FetchLike = async (input, init) => {
    if (this.offline) throw new TypeError('Failed to fetch');
    const url = new URL(input, 'http://x');
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (auth !== `Bearer ${this.token}`) return json(401, { error: { code: 'unauthorized', message: 'no' } });
    if (url.pathname === '/api/sync/push') {
      const req = JSON.parse(String(init!.body)) as { ops: PushOp[] };
      if (req.ops.length > 100) return json(400, { error: { code: 'bad_request', message: 'too many' } });
      this.pushCalls.push(req.ops);
      const results = req.ops.map((o): PushResult => {
        if (this.contention > 0) {
          this.contention--;
          return { opId: o.opId, status: 'rejected', memo: null, message: 'contention_retry_later' };
        }
        return this.apply(o);
      });
      if (this.dropAfterApply > 0) {
        this.dropAfterApply--;
        throw new TypeError('connection reset');
      }
      return json(200, { results, serverSeq: this.seq });
    }
    if (url.pathname === '/api/sync/pull') {
      const since = Number(url.searchParams.get('since'));
      const limit = Number(url.searchParams.get('limit'));
      const all = [...this.memos.values()]
        .filter((m) => (m.serverSeq ?? 0) > since)
        .sort((a, b) => a.serverSeq! - b.serverSeq!);
      const changes = all.slice(0, limit);
      return json(200, {
        changes,
        nextSince: changes.length ? changes[changes.length - 1]!.serverSeq : since,
        hasMore: all.length > limit,
      });
    }
    if (url.pathname === '/api/images/summarize') {
      const req = JSON.parse(String(init!.body)) as { memoId: string };
      this.summarizeCalls.push(req.memoId);
      const r = this.summarize(req.memoId);
      if (r instanceof Response) return r;
      return json(200, { summary: r.summary, model: 'mock' });
    }
    return json(404, { error: { code: 'not_found', message: url.pathname } });
  };
}
