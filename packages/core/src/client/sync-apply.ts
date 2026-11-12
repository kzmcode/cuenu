// push 結果・pull 変更をローカルへ反映する（トランザクション内で使う純粋なロジック）。

import type { PushOp, PushResult } from '../api';
import type { Memo } from '../types';
import type { StoredMemo, StoredOp, Tx } from './backend';
import { adoptServer, enqueueDelete, enqueueUpsert, sameImage } from './ops';
import { nowIso, uuid } from './util';

export const RESCUE_NOTE = '> 別の端末で削除された投稿への未送信の編集を、新しいメモとして残しました。';

const isBodyEdit = (o: StoredOp) =>
  o.kind === 'upsert' && !!o.memo && o.memo.version === o.baseVersion + 1;

/**
 * 削除（tombstone）で失われる未送信の本文編集を新しいメモとして保存する。
 * 要件「本文を無言で失わない」。同じメモを二重に救出しないよう meta に記録する。
 */
async function rescueUnsentEdit(tx: Tx, m: StoredMemo | undefined, ops: StoredOp[]) {
  // ローカルで削除済み（利用者が削除を選んだ）なら救出しない
  if (!m || m.author !== 'user' || m.deletedAt || ops.some((o) => o.kind === 'delete')) return;
  const edit = [...ops].reverse().find(isBodyEdit);
  if (!edit) return;
  const key = `rescued:${m.id}`;
  if (await tx.getMeta<boolean>(key)) return;
  await tx.setMeta(key, true);
  const text = m.body;
  if (!text.trim()) return;
  let parentId: string | null = null;
  if (m.parentId) {
    const parent = await tx.getMemo(m.parentId);
    if (parent && !parent.deletedAt) parentId = parent.id;
  }
  const now = nowIso();
  const rescued: StoredMemo = {
    id: uuid(),
    parentId,
    author: 'user',
    body: `${RESCUE_NOTE}\n\n${text}`,
    createdAt: now,
    updatedAt: now,
    editedAt: null,
    version: 0,
    deletedAt: null,
    tags: [],
    emoji: null,
    tagsVersion: null,
    ai: null,
    image: null,
    serverSeq: null,
    syncState: 'pending',
    syncError: null,
    conflict: null,
    serverVersion: 0,
  };
  await enqueueUpsert(tx, rescued, true);
}

/** 再送すれば通りうる rejected（担当A のサーバー実装の message） */
const RETRYABLE_REJECTS = new Set(['contention_retry_later', 'internal_error']);

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrOrNull = (v: unknown) => v === null || typeof v === 'string';

/**
 * サーバー応答のメモを検証する（信頼できない入力）。必須フィールドが壊れていれば null。
 * tags は文字列のみ残す。expectId を渡すと別 ID のメモを拒否する。
 */
export function sanitizeServerMemo(x: unknown, expectId?: string): Memo | null {
  if (!x || typeof x !== 'object') return null;
  const m = x as Memo;
  if (!isStr(m.id) || (expectId !== undefined && m.id !== expectId)) return null;
  if (!isStr(m.body) || !isStr(m.createdAt) || !isStrOrNull(m.parentId) || !isStrOrNull(m.deletedAt)) return null;
  if (typeof m.version !== 'number' || !Number.isFinite(m.version)) return null;
  return {
    ...m,
    author: m.author === 'ai' ? 'ai' : 'user',
    tags: Array.isArray(m.tags) ? m.tags.filter(isStr) : [],
    ai: m.ai ?? null,
    image: m.image ?? null,
  };
}

export const toPushOp = (o: StoredOp): PushOp => ({
  opId: o.opId,
  memoId: o.memoId,
  kind: o.kind,
  baseVersion: o.baseVersion,
  memo: o.memo,
});

/** サーバー版を採用し、自端末の画像状態の方が進んでいれば再送 op を積む */
async function putAdopted(tx: Tx, local: StoredMemo | undefined, server: Memo, deviceId: string) {
  const next = adoptServer(local, server, deviceId);
  if (!next.deletedAt && !sameImage(next.image, server.image)) {
    await enqueueUpsert(tx, next, false);
  } else {
    await tx.putMemo(next);
  }
  return next;
}

async function tombstoneChildren(tx: Tx, parentId: string, deletedAt: string) {
  for (const r of await tx.childrenOf(parentId)) {
    if (r.deletedAt) continue;
    const ops = await tx.opsForMemo(r.id);
    await rescueUnsentEdit(tx, r, ops);
    for (const o of ops) if (!o.sending) await tx.deleteOp(o.opId);
    r.deletedAt = deletedAt;
    r.syncState = 'synced';
    await tx.putMemo(r);
  }
}

export async function applyPushResults(
  tx: Tx,
  sent: StoredOp[],
  results: PushResult[],
  deviceId: string,
): Promise<{ resolved: number; deferred: number }> {
  const byId = new Map(results.filter((r) => r && typeof r.opId === 'string').map((r) => [r.opId, r]));
  let resolved = 0;
  let deferred = 0;
  for (const sentOp of sent) {
    const memoOps = await tx.opsForMemo(sentOp.memoId);
    const op = memoOps.find((o) => o.opId === sentOp.opId);
    if (!op) continue; // pull 等で既に取り除かれた
    const r = byId.get(op.opId);
    if (!r) {
      op.sending = false;
      op.attempts++;
      op.lastError = 'no result';
      await tx.putOp(op);
      continue;
    }
    if (r.status === 'rejected' && r.message && RETRYABLE_REJECTS.has(r.message)) {
      // サーバー側の一時的な失敗。op は残して次回再送
      op.sending = false;
      op.attempts++;
      op.lastError = r.message;
      await tx.putOp(op);
      deferred++;
      continue;
    }
    resolved++;
    const rest = memoOps.filter((o) => o.opId !== op.opId);
    const m = await tx.getMemo(op.memoId);
    await tx.deleteOp(op.opId);
    // 別メモ・壊れたメモが返っても他のレコードを上書きしない
    const serverMemo = sanitizeServerMemo(r.memo, op.memoId);

    switch (r.status) {
      case 'applied':
      case 'duplicate': {
        if (!m) break;
        if (serverMemo) {
          if (rest.length === 0 && !m.conflict) {
            await putAdopted(tx, m, serverMemo, deviceId);
          } else {
            // 後続の未送信がある（または競合中）: 本文はローカルのまま、サーバー側の情報だけ更新
            m.serverVersion = serverMemo.version;
            m.serverSeq = serverMemo.serverSeq;
            m.tags = [...serverMemo.tags];
            m.tagsVersion = serverMemo.tagsVersion;
            m.emoji = serverMemo.emoji ?? null;
            if (rest.length === 0) {
              m.syncState = 'conflict';
              m.syncError = null;
            }
            await tx.putMemo(m);
          }
        } else if (rest.length === 0) {
          m.syncState = m.conflict ? 'conflict' : 'synced';
          m.syncError = null;
          await tx.putMemo(m);
        }
        break;
      }
      case 'conflict': {
        if (!m) break;
        if (!serverMemo) {
          // 比較対象のサーバー版が無い: 編集を捨てずにエラー表示へ
          m.syncState = 'error';
          m.syncError = r.message ?? 'サーバー版を取得できませんでした';
          await tx.putMemo(m);
          break;
        }
        const server = serverMemo;
        const pendingDelete = rest.find((o) => o.kind === 'delete');
        // この op を前提にした後続 upsert は無効
        for (const o of rest) if (o.kind === 'upsert') await tx.deleteOp(o.opId);
        if (op.kind === 'delete') {
          // 削除を最新版に対して出し直す（削除はローカル優先）
          m.serverVersion = server.version;
          m.version = server.version;
          await tx.putMemo(m);
          if (!pendingDelete) await enqueueDelete(tx, m);
          break;
        }
        // 後続 op（破棄済み）に本文編集があれば、それも競合として保持する
        const bodyEdited = isBodyEdit(op) || rest.some(isBodyEdit);
        const next = adoptServer(m, server, deviceId);
        if (bodyEdited && m.body !== server.body && !server.deletedAt) {
          next.conflict = {
            server,
            localBody: m.body,
            localBaseVersion: op.baseVersion,
            detectedAt: nowIso(),
          };
          next.syncState = 'conflict';
        }
        if (pendingDelete && !server.deletedAt) {
          next.deletedAt = m.deletedAt;
          next.syncState = 'pending';
          await tx.putMemo(next);
        } else if (!next.conflict && !next.deletedAt && !sameImage(next.image, server.image)) {
          await enqueueUpsert(tx, next, false);
        } else {
          await tx.putMemo(next);
        }
        break;
      }
      case 'gone': {
        await rescueUnsentEdit(tx, m, [op, ...rest]);
        for (const o of rest) await tx.deleteOp(o.opId);
        if (!m) break;
        const next = serverMemo ? adoptServer(m, serverMemo, deviceId) : { ...m, syncState: 'synced' as const };
        next.deletedAt = next.deletedAt ?? m.deletedAt ?? nowIso();
        next.conflict = null;
        await tx.putMemo(next);
        if (!next.parentId) await tombstoneChildren(tx, next.id, next.deletedAt);
        break;
      }
      case 'rejected':
      default: {
        if (!m) break;
        m.syncState = 'error';
        m.syncError = r.message ?? 'サーバーが変更を拒否しました';
        await tx.putMemo(m);
        break;
      }
    }
  }
  return { resolved, deferred };
}

export async function applyPulledChanges(tx: Tx, changes: unknown[], deviceId: string): Promise<void> {
  for (const raw of changes) {
    const s = sanitizeServerMemo(raw);
    if (!s) continue;
    const m = await tx.getMemo(s.id);
    const ops = await tx.opsForMemo(s.id);

    if (s.deletedAt) {
      // tombstone 優先。未送信の本文編集は新しいメモとして救出してから op を破棄
      // （送信中のものは結果 gone で片付く）
      await rescueUnsentEdit(tx, m, ops);
      for (const o of ops) if (!o.sending) await tx.deleteOp(o.opId);
      const next = adoptServer(m, s, deviceId);
      await tx.putMemo(next);
      if (!s.parentId) await tombstoneChildren(tx, s.id, s.deletedAt);
      continue;
    }
    if (!m) {
      await tx.putMemo(adoptServer(undefined, s, deviceId));
      continue;
    }
    if (ops.length > 0) {
      // 未送信あり: 本文・版・画像はローカル優先。サーバー由来の情報のみ更新
      m.serverVersion = s.version;
      m.serverSeq = s.serverSeq;
      m.tags = [...s.tags];
      m.tagsVersion = s.tagsVersion;
      m.emoji = s.emoji ?? null;
      m.ai = s.ai;
      if (m.conflict) m.conflict = { ...m.conflict, server: s };
      await tx.putMemo(m);
      continue;
    }
    if (m.deletedAt) continue; // 削除済みは復活させない
    if (m.conflict) {
      const next = adoptServer(m, s, deviceId);
      if (s.body !== m.conflict.localBody) {
        next.conflict = { ...m.conflict, server: s };
        next.syncState = 'conflict';
      }
      await tx.putMemo(next);
      continue;
    }
    await putAdopted(tx, m, s, deviceId);
  }
}
