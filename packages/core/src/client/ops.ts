// 送信キュー操作（トランザクション内で使う）。
// 不変条件:
// - 1メモにつき「未送信（sending=false）の upsert」は最大1つ。編集はそれに圧縮する。
// - 送信中 op がある間の編集は、その op の適用後の版を baseVersion とする新 op を後ろに積む。
// - 表示上の memo.version は「最後の op の payload.version」か、op が無ければ serverVersion。

import type { ImageSummaryState, Memo, SyncMemoPayload } from '../types';
import type { StoredMemo, StoredOp, Tx } from './backend';
import { RepoError, nowIso, uuid } from './util';

export function toPayload(m: StoredMemo): SyncMemoPayload {
  return {
    id: m.id,
    parentId: m.parentId,
    body: m.body,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    version: m.version,
    image: m.image ? { ...m.image } : null,
    ...(m.author === 'ai' ? { liked: !!m.liked } : {}),
  };
}

async function nextSeq(tx: Tx): Promise<number> {
  const cur = (await tx.getMeta<number>('opSeq')) ?? 0;
  await tx.setMeta('opSeq', cur + 1);
  return cur + 1;
}

/** memo（変更済み）を保存し upsert op を積む/圧縮する。bodyChanged=false は image 等のみの更新 */
export async function enqueueUpsert(tx: Tx, memo: StoredMemo, bodyChanged: boolean): Promise<StoredMemo> {
  const ops = await tx.opsForMemo(memo.id);
  const last = ops[ops.length - 1];
  if (last?.kind === 'delete') throw new RepoError('deleted');
  if (last && !last.sending && last.memo) {
    const bodyEdit = bodyChanged || last.memo.version === last.baseVersion + 1;
    memo.version = last.baseVersion + (bodyEdit ? 1 : 0);
    last.memo = toPayload(memo);
    last.lastError = null;
    await tx.putOp(last);
  } else {
    const base = last?.memo ? last.memo.version : memo.serverVersion;
    memo.version = base + (bodyChanged || base === 0 ? 1 : 0);
    await tx.putOp({
      opId: uuid(),
      memoId: memo.id,
      kind: 'upsert',
      baseVersion: base,
      memo: toPayload(memo),
      createdAt: nowIso(),
      attempts: 0,
      lastError: null,
      seq: await nextSeq(tx),
      sending: false,
    });
  }
  memo.syncState = 'pending';
  memo.syncError = null;
  await tx.putMemo(memo);
  return memo;
}

export async function enqueueDelete(tx: Tx, memo: StoredMemo): Promise<void> {
  await tx.putOp({
    opId: uuid(),
    memoId: memo.id,
    kind: 'delete',
    baseVersion: memo.version,
    memo: null,
    createdAt: nowIso(),
    attempts: 0,
    lastError: null,
    seq: await nextSeq(tx),
    sending: false,
  });
}

const IMAGE_RANK: Record<ImageSummaryState['status'], number> = {
  waiting: 0,
  processing: 1,
  failed: 2,
  done: 3,
  cancelled: 3,
};

/** 自端末が元端末で、ローカルの画像状態の方が進んでいればローカルを優先 */
export function mergeImage(
  local: ImageSummaryState | null,
  server: ImageSummaryState | null,
  deviceId: string,
): ImageSummaryState | null {
  if (!local || local.originDeviceId !== deviceId) return server;
  if (!server) return local;
  const lr = IMAGE_RANK[local.status];
  const sr = IMAGE_RANK[server.status];
  if (lr > sr || (lr === sr && local.applied && !server.applied)) return local;
  return server;
}

/** サーバー版の内容でローカルを上書き（未送信 op が無いときに使う） */
export function adoptServer(m: StoredMemo | undefined, s: Memo, deviceId: string): StoredMemo {
  return {
    ...s,
    tags: [...s.tags],
    image: mergeImage(m?.image ?? null, s.image, deviceId),
    serverVersion: s.version,
    syncState: 'synced',
    syncError: null,
    conflict: null,
  };
}

export function sameImage(a: ImageSummaryState | null, b: ImageSummaryState | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.status === b.status &&
    a.originDeviceId === b.originDeviceId &&
    a.summary === b.summary &&
    a.applied === b.applied &&
    a.error === b.error &&
    a.baseVersion === b.baseVersion
  );
}
