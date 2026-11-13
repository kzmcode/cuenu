import type { ImageSummaryState, Memo, PullResponse, PushOp, PushRequest, PushResponse, PushResult } from '@cuenu/core';
import type { Ctx } from './context';
import { BUMP_SEQ, SEQ_VALUE, currentSeq, stmt, type Stmt } from './db';
import { badRequest } from './http';
import { getMemo, getMemoRow, rowToMemo, type MemoRow } from './memos';
import { isIsoDate } from './util';

const MAX_OPS = 100;
const MAX_BODY_CHARS = 200_000;
const MAX_IMAGE_JSON = 20_000;
const MAX_ID = 100;

type Result = Omit<PushResult, 'opId'>;

export async function push(ctx: Ctx, deviceId: string, req: PushRequest): Promise<PushResponse> {
  if (!req || !Array.isArray(req.ops)) throw badRequest('ops must be an array');
  if (req.ops.length > MAX_OPS) throw badRequest(`too many ops (max ${MAX_OPS})`);
  const results: PushResult[] = [];
  for (const op of req.ops) {
    const opId = typeof op?.opId === 'string' ? op.opId : '';
    let r: Result;
    try {
      r = await applyWithRetry(ctx, deviceId, op);
    } catch (e) {
      console.error('push op failed', opId, e);
      r = { status: 'rejected', memo: null, message: 'internal_error' };
    }
    results.push({ opId, ...r });
  }
  return { results, serverSeq: await currentSeq(ctx.db) };
}

async function applyWithRetry(ctx: Ctx, deviceId: string, op: PushOp): Promise<Result> {
  const invalid = validateOp(op);
  if (invalid) return { status: 'rejected', memo: null, message: invalid };
  // 条件付き書き込みが競合で空振りした場合は状態を読み直して再判定する
  for (let i = 0; i < 3; i++) {
    const r = await applyOp(ctx, deviceId, op);
    if (r !== 'retry') return r;
  }
  return { status: 'rejected', memo: null, message: 'contention_retry_later' };
}

function validateOp(op: PushOp): string | null {
  if (!op || typeof op !== 'object') return 'invalid_op';
  if (typeof op.opId !== 'string' || !op.opId || op.opId.length > MAX_ID) return 'invalid_opId';
  if (typeof op.memoId !== 'string' || !op.memoId || op.memoId.length > MAX_ID) return 'invalid_memoId';
  if (op.kind !== 'upsert' && op.kind !== 'delete') return 'invalid_kind';
  if (!Number.isInteger(op.baseVersion) || op.baseVersion < 0) return 'invalid_baseVersion';
  if (op.kind === 'upsert') {
    const m = op.memo;
    if (!m || typeof m !== 'object') return 'memo_required';
    if (m.id !== op.memoId) return 'memo_id_mismatch';
    if (typeof m.body !== 'string') return 'invalid_body';
    if (m.body.length > MAX_BODY_CHARS) return 'body_too_large';
    if (m.parentId !== null && (typeof m.parentId !== 'string' || m.parentId.length > MAX_ID)) return 'invalid_parentId';
    if (m.parentId === m.id) return 'invalid_parentId';
    if (!isIsoDate(m.createdAt)) return 'invalid_createdAt';
    if (m.editedAt !== null && !isIsoDate(m.editedAt)) return 'invalid_editedAt';
    if (!Number.isInteger(m.version) || m.version < 1) return 'invalid_version';
    if (m.image !== null && (typeof m.image !== 'object' || JSON.stringify(m.image).length > MAX_IMAGE_JSON)) {
      return 'invalid_image';
    }
  }
  return null;
}

/** sync_ops への記録。memo の last_op_id が当該 op の場合のみ（=書き込み成功時のみ）入る */
function recordOp(op: PushOp, deviceId: string, now: string): Stmt {
  return stmt(
    `INSERT OR IGNORE INTO sync_ops (op_id, memo_id, device_id, kind, server_seq, applied_at)
     SELECT ?, ?, ?, ?, ${SEQ_VALUE}, ? WHERE EXISTS (SELECT 1 FROM memos WHERE id = ? AND last_op_id = ?)`,
    op.opId,
    op.memoId,
    deviceId,
    op.kind,
    now,
    op.memoId,
    op.opId,
  );
}

function insertTombstone(id: string, parentId: string | null, version: number, createdAt: string, now: string, opId: string): Stmt {
  return stmt(
    `INSERT OR IGNORE INTO memos (id, parent_id, author, body, created_at, updated_at, edited_at, version, deleted_at,
       tags, tags_version, ai, image, server_seq, last_op_id)
     VALUES (?, ?, 'user', '', ?, ?, NULL, ?, ?, '[]', NULL, NULL, NULL, ${SEQ_VALUE}, ?)`,
    id,
    parentId,
    createdAt,
    now,
    version,
    now,
    opId,
  );
}

/**
 * メモを tombstone 化する文（本文・タグ・画像状態は消す。ai メタは残す）。
 * noLiveReplies: 生きた返信が残っていれば更新しない（列挙後に並行で作られた返信の取り残し防止。空振りは再判定される）
 */
function tombstoneStmts(id: string, now: string, opId: string | null, noLiveReplies = false): Stmt[] {
  return [
    BUMP_SEQ,
    stmt(
      `UPDATE memos SET deleted_at = ?, body = '', tags = '[]', emoji = NULL, image = NULL, updated_at = ?,
         server_seq = ${SEQ_VALUE}, last_op_id = COALESCE(?, last_op_id)
       WHERE id = ? AND deleted_at IS NULL${
         noLiveReplies ? ` AND NOT EXISTS (SELECT 1 FROM memos r WHERE r.parent_id = memos.id AND r.deleted_at IS NULL)` : ''
       }`,
      now,
      now,
      opId,
      id,
    ),
    stmt(`DELETE FROM embeddings WHERE memo_id = ?`, id),
    stmt(`DELETE FROM jobs WHERE target_id = ?`, id),
  ];
}

async function deleteWithReplies(ctx: Ctx, server: MemoRow, now: string, opId: string | null): Promise<Stmt[]> {
  const out: Stmt[] = [];
  const isParent = server.parent_id === null;
  if (isParent) {
    const replies = await ctx.db.all<{ id: string }>(
      `SELECT id FROM memos WHERE parent_id = ? AND deleted_at IS NULL`,
      server.id,
    );
    for (const r of replies) out.push(...tombstoneStmts(r.id, now, null));
  }
  // 親を最後に（last_op_id による記録判定のため最後の SEQ_VALUE を親にする）
  out.push(...tombstoneStmts(server.id, now, opId, isParent));
  return out;
}

async function commit(ctx: Ctx, op: PushOp, deviceId: string, now: string, writes: Stmt[], ok: Status): Promise<Result | 'retry'> {
  const rs = await ctx.db.batch([...writes, recordOp(op, deviceId, now)]);
  if ((rs[rs.length - 1]?.changes ?? 0) === 0) return 'retry';
  return { status: ok, memo: await getMemo(ctx.db, op.memoId) };
}
type Status = PushResult['status'];

async function applyOp(ctx: Ctx, deviceId: string, op: PushOp): Promise<Result | 'retry'> {
  const db = ctx.db;
  const dup = await db.first<{ memo_id: string }>(`SELECT memo_id FROM sync_ops WHERE op_id = ?`, op.opId);
  if (dup) return { status: 'duplicate', memo: await getMemo(db, op.memoId) };

  const now = ctx.now().toISOString();
  const server = await getMemoRow(db, op.memoId);

  if (op.kind === 'delete') {
    if (!server) {
      // 未同期のまま削除された記録: tombstone を作り、後から届く古い upsert で復活させない
      const pid = op.memo?.parentId;
      const parentId = typeof pid === 'string' && pid.length <= MAX_ID ? pid : null;
      const createdAt = op.memo && isIsoDate(op.memo.createdAt) ? op.memo.createdAt : now;
      return commit(
        ctx,
        op,
        deviceId,
        now,
        [BUMP_SEQ, insertTombstone(op.memoId, parentId, Math.max(1, op.baseVersion), createdAt, now, op.opId)],
        'applied',
      );
    }
    if (server.deleted_at) return { status: 'gone', memo: rowToMemo(server) };
    return commit(ctx, op, deviceId, now, await deleteWithReplies(ctx, server, now, op.opId), 'applied');
  }

  const p = op.memo!;
  if (!server) {
    if (p.parentId) {
      const parent = await getMemoRow(db, p.parentId);
      if (!parent) return { status: 'rejected', memo: null, message: 'parent_not_found' };
      if (parent.parent_id !== null) return { status: 'rejected', memo: null, message: 'parent_is_reply' };
      if (parent.deleted_at) {
        // 親が削除済み → 返信も削除扱い
        return commit(
          ctx,
          op,
          deviceId,
          now,
          [BUMP_SEQ, insertTombstone(p.id, p.parentId, p.version, p.createdAt, now, op.opId)],
          'gone',
        );
      }
    }
    return commit(
      ctx,
      op,
      deviceId,
      now,
      [
        BUMP_SEQ,
        stmt(
          // 親の確認後に親が削除された場合は挿入しない（空振り → 再判定で gone）
          `INSERT OR IGNORE INTO memos (id, parent_id, author, body, created_at, updated_at, edited_at, version,
             deleted_at, tags, tags_version, ai, image, server_seq, last_op_id)
           SELECT ?, ?, 'user', ?, ?, ?, ?, ?, NULL, '[]', NULL, NULL, ?, ${SEQ_VALUE}, ?
           WHERE ? IS NULL OR EXISTS (SELECT 1 FROM memos WHERE id = ? AND deleted_at IS NULL)`,
          p.id,
          p.parentId,
          p.body,
          p.createdAt,
          now,
          p.editedAt,
          p.version,
          imageJson(p.image),
          op.opId,
          p.parentId,
          p.parentId,
        ),
      ],
      'applied',
    );
  }

  if (server.deleted_at) return { status: 'gone', memo: rowToMemo(server) };
  if (op.baseVersion === 0) return { status: 'conflict', memo: rowToMemo(server) };

  if (server.author === 'ai') {
    if (p.body !== server.body) return { status: 'rejected', memo: rowToMemo(server), message: 'ai_memo_readonly' };
    // AI 投稿で変更できるのは「いいね」だけ（本文・版は不変）
    if (typeof p.liked === 'boolean' && p.liked !== !!server.liked) {
      return commit(
        ctx,
        op,
        deviceId,
        now,
        [
          BUMP_SEQ,
          stmt(
            `UPDATE memos SET liked = ?, liked_at = ?, updated_at = ?, server_seq = ${SEQ_VALUE}, last_op_id = ?
             WHERE id = ? AND author = 'ai' AND deleted_at IS NULL`,
            p.liked ? 1 : 0,
            p.liked ? now : null,
            now,
            op.opId,
            p.id,
          ),
        ],
        'applied',
      );
    }
    return { status: 'applied', memo: rowToMemo(server) };
  }

  // image のみ更新（version 不変）
  if (p.version === server.version && p.body === server.body) {
    return commit(
      ctx,
      op,
      deviceId,
      now,
      [
        BUMP_SEQ,
        stmt(
          `UPDATE memos SET image = ?, updated_at = ?, server_seq = ${SEQ_VALUE}, last_op_id = ?
           WHERE id = ? AND version = ? AND body = ? AND deleted_at IS NULL`,
          imageJson(p.image),
          now,
          op.opId,
          p.id,
          server.version,
          server.body,
        ),
      ],
      'applied',
    );
  }

  if (server.version !== op.baseVersion) return { status: 'conflict', memo: rowToMemo(server) };
  if (p.version !== op.baseVersion + 1) {
    return { status: 'rejected', memo: rowToMemo(server), message: 'version_must_be_baseVersion_plus_1' };
  }
  const writes: Stmt[] = [
    BUMP_SEQ,
    stmt(
      `UPDATE memos SET body = ?, edited_at = ?, version = ?, image = ?, updated_at = ?,
         server_seq = ${SEQ_VALUE}, last_op_id = ?
       WHERE id = ? AND version = ? AND deleted_at IS NULL`,
      p.body,
      p.editedAt ?? now,
      p.version,
      imageJson(p.image),
      now,
      op.opId,
      p.id,
      op.baseVersion,
    ),
  ];
  if (p.body !== server.body) writes.push(stmt(`DELETE FROM embeddings WHERE memo_id = ?`, p.id));
  return commit(ctx, op, deviceId, now, writes, 'applied');
}

function imageJson(img: ImageSummaryState | null): string | null {
  return img ? JSON.stringify(img) : null;
}

const PULL_DEFAULT = 200;
const PULL_MAX = 500;

export async function pull(ctx: Ctx, since: number, limit: number): Promise<PullResponse> {
  const rows = await ctx.db.all<MemoRow>(
    `SELECT * FROM memos WHERE server_seq > ? ORDER BY server_seq ASC LIMIT ?`,
    since,
    limit + 1,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const changes: Memo[] = page.map(rowToMemo);
  const nextSince = page.length ? page[page.length - 1]!.server_seq : since;
  return { changes, nextSince, hasMore };
}

export function parsePullParams(url: URL): { since: number; limit: number } {
  const sinceRaw = url.searchParams.get('since') ?? '0';
  const limitRaw = url.searchParams.get('limit');
  const since = Number(sinceRaw);
  if (!Number.isInteger(since) || since < 0) throw badRequest('invalid since');
  let limit = limitRaw === null ? PULL_DEFAULT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) throw badRequest('invalid limit');
  limit = Math.min(limit, PULL_MAX);
  return { since, limit };
}
