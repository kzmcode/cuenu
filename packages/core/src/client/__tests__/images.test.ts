import { describe, expect, it } from 'vitest';
import { createMemoryRepository } from '../factories';
import { createSyncController } from '../sync';
import { MockServer } from './mock-server';

const png = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

function setup(deviceId = 'A', server = new MockServer()) {
  const repo = createMemoryRepository({ deviceId, connected: true });
  const sync = createSyncController(repo, { serverUrl: 'https://s', token: server.token, deviceId }, server.fetch);
  return { server, repo, sync };
}

describe('画像要約キュー', () => {
  it('waiting で作成し、完了時に本文末尾へ反映して一時画像を削除', async () => {
    const { server, repo, sync } = setup();
    const m = await repo.create({ body: 'ホワイトボード', image: png() });
    expect(m.image).toMatchObject({ status: 'waiting', originDeviceId: 'A', baseVersion: 1 });
    expect(await repo.internal.backend.getImage(m.id)).toBeDefined();
    await sync.processImages();
    const done = await repo.get(m.id);
    expect(done?.body).toBe('ホワイトボード\n\n画像の要約');
    expect(done?.image).toMatchObject({ status: 'done', applied: true, summary: '画像の要約' });
    expect(await repo.internal.backend.getImage(m.id)).toBeUndefined();
    await sync.syncNow();
    expect(server.memos.get(m.id)?.body).toBe('ホワイトボード\n\n画像の要約');
    expect(server.memos.get(m.id)?.image?.status).toBe('done');
  });

  it('要約完了前にユーザーが編集したら本文を上書きせず summary に保持', async () => {
    const { repo, sync } = setup();
    const m = await repo.create({ body: '', image: png() });
    await sync.syncNow();
    await repo.updateBody(m.id, '自分で書いた');
    await sync.processImages();
    const r = await repo.get(m.id);
    expect(r?.body).toBe('自分で書いた');
    expect(r?.image).toMatchObject({ status: 'done', applied: false, summary: '画像の要約' });
    const applied = await repo.applyImageSummary(m.id);
    expect(applied.body).toBe('自分で書いた\n\n画像の要約');
    expect(applied.image?.applied).toBe(true);
    await expect(repo.applyImageSummary(m.id)).rejects.toMatchObject({ code: 'no_summary' });
  });

  it('同期前（新規 op に圧縮される）の編集でも上書きしない', async () => {
    const { repo, sync, server } = setup();
    server.offline = true;
    const m = await repo.create({ body: '', image: png() });
    await repo.updateBody(m.id, '先に編集');
    server.offline = false;
    await sync.processImages();
    expect((await repo.get(m.id))?.body).toBe('先に編集');
  });

  it('他端末の編集で version が変わっていたら反映しない', async () => {
    const { repo, sync, server } = setup();
    const m = await repo.create({ body: '', image: png() });
    await sync.syncNow();
    server.serverEdit(m.id, { body: '別端末で編集', version: 2 });
    await sync.syncNow();
    await sync.processImages();
    const r = await repo.get(m.id);
    expect(r?.body).toBe('別端末で編集');
    expect(r?.image?.summary).toBe('画像の要約');
    expect(r?.image?.applied).toBe(false);
  });

  it('失敗時は画像を残して failed、retry で再処理、cancel で削除', async () => {
    const { repo, sync, server } = setup();
    server.summarize = () =>
      new Response(JSON.stringify({ error: { code: 'bad_request', message: '読めない画像' } }), { status: 400 });
    const m = await repo.create({ body: 'x', image: png() });
    await sync.processImages();
    expect((await repo.get(m.id))?.image).toMatchObject({ status: 'failed', error: '読めない画像' });
    expect(await repo.internal.backend.getImage(m.id)).toBeDefined();
    server.summarize = () => ({ summary: 'OK' });
    await repo.retryImageSummary(m.id);
    await sync.processImages();
    expect((await repo.get(m.id))?.image?.status).toBe('done');

    const m2 = await repo.create({ body: 'y', image: png() });
    await repo.cancelImageSummary(m2.id);
    expect((await repo.get(m2.id))?.image?.status).toBe('cancelled');
    expect(await repo.internal.backend.getImage(m2.id)).toBeUndefined();
  });

  it('429 は waiting のまま待機し、画像を消さない', async () => {
    const { repo, sync, server } = setup();
    server.summarize = () =>
      new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow', retryAfterSec: 30 } }), {
        status: 429,
      });
    const m = await repo.create({ body: 'x', image: png() });
    await sync.processImages();
    expect((await repo.get(m.id))?.image?.status).toBe('waiting');
    expect(await repo.internal.backend.getImage(m.id)).toBeDefined();
    const calls = server.summarizeCalls.length;
    await sync.processImages(); // 待機中は送らない
    expect(server.summarizeCalls.length).toBe(calls);
  });

  it('オフラインでは waiting のまま', async () => {
    const { repo, sync, server } = setup();
    server.offline = true;
    const m = await repo.create({ body: 'x', image: png() });
    await sync.processImages();
    expect((await repo.get(m.id))?.image?.status).toBe('waiting');
  });

  it('元端末以外では処理しない（waiting 状態だけ同期される）', async () => {
    const server = new MockServer();
    const a = setup('A', server);
    const b = setup('B', server);
    const m = await a.repo.create({ body: 'x', image: png() });
    await a.sync.syncNow();
    await b.sync.syncNow();
    const onB = await b.repo.get(m.id);
    expect(onB?.image).toMatchObject({ status: 'waiting', originDeviceId: 'A' });
    await b.sync.processImages();
    expect(server.summarizeCalls).toHaveLength(0);
    await a.sync.processImages();
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect((await b.repo.get(m.id))?.image?.status).toBe('done');
    expect((await b.repo.get(m.id))?.body).toBe('x\n\n画像の要約');
  });

  it('削除済みメモの画像は処理しない', async () => {
    const { repo, sync, server } = setup();
    const m = await repo.create({ body: 'x', image: png() });
    await repo.remove(m.id);
    await sync.processImages();
    expect(server.summarizeCalls).toHaveLength(0);
    await sync.syncNow();
    await sync.processImages();
    expect(await repo.internal.backend.getImage(m.id)).toBeUndefined();
  });

  it('ログインで deviceId が変わっても自端末の待機画像を処理できる', async () => {
    const server = new MockServer();
    const repo = createMemoryRepository({ connected: true });
    const m = await repo.create({ body: '', image: png() });
    const sync = createSyncController(repo, { serverUrl: 'https://s', token: 'tok', deviceId: 'server-issued' }, server.fetch);
    await sync.syncNow();
    expect((await repo.get(m.id))?.image?.originDeviceId).toBe('server-issued');
    await sync.processImages();
    expect((await repo.get(m.id))?.image?.status).toBe('done');
  });
});
