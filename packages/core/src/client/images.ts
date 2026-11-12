// 画像要約キュー。元画像は端末内（images ストア）にのみ一時保持し、要約のローカル保存成功後に削除する。

import type { ApiClient } from './api-client';
import { isApiRequestError } from './api-client';
import type { ImageRecord } from './backend';
import { enqueueUpsert } from './ops';
import { appendSummary, type CuenuRepository } from './repo';
import { bytesToBase64, createCrossTabLock, nowIso } from './util';

/** 送信上限（base64 で ~4MB になる生バイト数） */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_EDGE = 1600;

/** 可能なら縮小して JPEG 化。縮小できない環境では元データのまま（上限超過は失敗） */
export async function prepareImage(rec: ImageRecord): Promise<{ mimeType: string; bytes: Uint8Array }> {
  const original = { mimeType: rec.mimeType, bytes: new Uint8Array(rec.data) };
  const canResize = typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined';
  if (canResize) {
    try {
      const bmp = await createImageBitmap(new Blob([rec.data], { type: rec.mimeType }));
      const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
      const needs = scale < 1 || rec.data.byteLength > 1024 * 1024 || !/^image\/(jpeg|png|webp)$/.test(rec.mimeType);
      if (needs) {
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(bmp, 0, 0, w, h);
          bmp.close();
          const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
          return { mimeType: 'image/jpeg', bytes: new Uint8Array(await out.arrayBuffer()) };
        }
      }
      bmp.close();
    } catch {
      /* デコード不可（HEIC 等）は元データで送る */
    }
  }
  return original;
}

export interface ImageProcessor {
  /** 待機中の画像要約を処理（多重起動は1本化）。オンライン復帰・再表示時に呼ぶ */
  run(): Promise<void>;
}

export function createImageProcessor(
  repo: CuenuRepository,
  getApi: () => ApiClient,
  opts: { canRun?: () => boolean; prepare?: typeof prepareImage } = {},
): ImageProcessor {
  const internal = repo.internal;
  const lock = createCrossTabLock(`cuenu-images:${repo.name}`);
  const prepare = opts.prepare ?? prepareImage;
  let running: Promise<void> | null = null;
  let again = false;
  let pausedUntil: number | null = null;

  const setImage = (id: string, patch: { status: 'waiting' | 'processing' | 'failed'; error: string | null }, enqueue: boolean) =>
    internal.write(async (tx) => {
      const m = await tx.getMemo(id);
      if (!m?.image || m.deletedAt) return;
      if (m.image.status === 'cancelled' || m.image.status === 'done') return;
      m.image = { ...m.image, ...patch };
      if (enqueue) await enqueueUpsert(tx, m, false);
      else await tx.putMemo(m);
    });

  async function processOne(id: string): Promise<'continue' | 'stop'> {
    const backend = internal.backend;
    const m = internal.cached(id);
    if (!m) return 'continue';
    const img = m.image;
    const finished = !img || img.status === 'done' || img.status === 'cancelled';
    // 削除済み（取り消し不能）・完了・キャンセル済みは一時画像を消す
    if (finished || (m.deletedAt && m.syncState !== 'pending')) {
      await internal.write((tx) => tx.deleteImage(id));
      return 'continue';
    }
    if (m.deletedAt || img.originDeviceId !== internal.deviceId || img.status === 'failed') return 'continue';

    const rec = await backend.getImage(id);
    if (!rec) return 'continue';
    await setImage(id, { status: 'processing', error: null }, false);
    let summary: string;
    try {
      const { mimeType, bytes } = await prepare(rec);
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('画像が大きすぎます');
      const res = await getApi().summarizeImage({ memoId: id, mimeType, dataBase64: bytesToBase64(bytes) });
      summary = res.summary;
    } catch (e) {
      if (isApiRequestError(e) && (e.isTransient || e.isAuthError)) {
        if (e.status === 429) pausedUntil = Date.now() + (e.retryAfterSec ?? 60) * 1000;
        await setImage(id, { status: 'waiting', error: null }, false);
        return 'stop';
      }
      const msg = e instanceof Error ? e.message : String(e);
      await setImage(id, { status: 'failed', error: msg }, true);
      return 'continue';
    }
    await internal.write(async (tx) => {
      const cur = await tx.getMemo(id);
      if (!cur?.image || cur.image.status === 'cancelled') {
        await tx.deleteImage(id);
        return;
      }
      const image = { ...cur.image, status: 'done' as const, summary, error: null, applied: false };
      // 要約待ちの間にユーザーが本文を編集していなければ本文末尾へ自動反映
      const untouched =
        !cur.deletedAt && !cur.conflict && cur.version === image.baseVersion && cur.editedAt === null;
      if (untouched) {
        cur.body = appendSummary(cur.body, summary);
        cur.updatedAt = nowIso();
        image.applied = true;
      }
      cur.image = image;
      if (cur.deletedAt) await tx.putMemo(cur);
      else await enqueueUpsert(tx, cur, untouched);
      // 要約の保存と同じトランザクションで一時画像を削除（保存失敗なら画像も残る）
      await tx.deleteImage(id);
    });
    return 'continue';
  }

  async function runOnce() {
    if (pausedUntil && Date.now() < pausedUntil) return;
    pausedUntil = null;
    if (opts.canRun && !opts.canRun()) return;
    await lock(async () => {
      const ids = await internal.backend.listImageIds();
      for (const id of ids) {
        if ((await processOne(id)) === 'stop') break;
      }
    });
  }

  return {
    run() {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        try {
          do {
            again = false;
            await runOnce();
          } while (again);
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
}
