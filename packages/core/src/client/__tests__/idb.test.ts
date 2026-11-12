import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createIdbRepository } from '../factories';
import { createSyncController } from '../sync';
import { dbNameFor } from '../util';
import { MockServer } from './mock-server';

let n = 0;
const uniqueUrl = () => `https://s${++n}.example.dev/`;

const waitFor = async (cond: () => Promise<boolean> | boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout');
};

describe('IndexedDB repository', () => {
  it('DB 名は接続先ごとに分離し、未接続は cuenu:local', () => {
    expect(dbNameFor(null)).toBe('cuenu:local');
    expect(dbNameFor('https://A.example/')).toBe(dbNameFor('https://a.example'));
    expect(dbNameFor('https://a.example')).not.toBe(dbNameFor('https://b.example'));
  });

  it('再起動（再オープン）後もメモ・送信キュー・下書き・一時画像が残る', async () => {
    const url = uniqueUrl();
    const r1 = await createIdbRepository({ serverUrl: url, deviceId: 'D1' });
    const m = await r1.create({ body: 'オフライン投稿' });
    await r1.updateBody(m.id, 'オフライン編集');
    const img = await r1.create({ body: '', image: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) });
    await r1.setDraft('main', '下書き');
    r1.close();

    const r2 = await createIdbRepository({ serverUrl: url });
    expect((await r2.get(m.id))?.body).toBe('オフライン編集');
    expect((await r2.search({ keyword: '編集' })).items).toHaveLength(1);
    expect(r2.syncStatus().pendingOps).toBe(2);
    expect(r2.syncStatus().initialImportDone).toBe(false);
    expect((await r2.getDraft('main'))?.body).toBe('下書き');
    expect(await r2.deviceId()).toBe('D1');
    const rec = await r2.internal.backend.getImage(img.id);
    expect(new Uint8Array(rec!.data)).toEqual(new Uint8Array([1, 2, 3]));
    r2.close();
  });

  it('接続先を変えると前環境の未送信は送られない', async () => {
    const server = new MockServer();
    const urlA = uniqueUrl();
    const urlB = uniqueUrl();
    const a = await createIdbRepository({ serverUrl: urlA });
    await a.create({ body: '環境Aの未送信' });
    a.close();
    const b = await createIdbRepository({ serverUrl: urlB });
    const sync = createSyncController(b, { serverUrl: urlB, token: 'tok', deviceId: 'D' }, server.fetch);
    await sync.syncNow();
    expect(server.pushCalls).toHaveLength(0);
    expect((await b.timeline()).items).toHaveLength(0);
    b.close();
  });

  it('トランザクション失敗時は何も書かれない', async () => {
    const repo = await createIdbRepository({ serverUrl: uniqueUrl() });
    const m = await repo.create({ body: 'x' });
    await expect(
      repo.internal.write(async (tx) => {
        const cur = (await tx.getMemo(m.id))!;
        cur.body = '途中まで';
        await tx.putMemo(cur);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    repo.close();
    const again = await createIdbRepository({ dbName: repo.name });
    expect((await again.get(m.id))?.body).toBe('x');
    again.close();
  });

  it('同じ DB を開いた別ウィンドウへ BroadcastChannel で変更が届く', async () => {
    const url = uniqueUrl();
    const quick = await createIdbRepository({ serverUrl: url });
    const main = await createIdbRepository({ serverUrl: url });
    const remote: string[] = [];
    main.subscribe((e) => e.type === 'memo-changed' && e.origin === 'remote' && remote.push(...e.ids));
    const m = await quick.create({ body: 'クイック入力から' });
    await waitFor(() => remote.includes(m.id));
    expect((await main.get(m.id))?.body).toBe('クイック入力から');
    expect(main.syncStatus().pendingOps).toBe(1);
    quick.close();
    main.close();
  });

  it('2 ウィンドウ同時の編集は互いを上書きせず、op は1つに圧縮される', async () => {
    const url = uniqueUrl();
    const w1 = await createIdbRepository({ serverUrl: url });
    const w2 = await createIdbRepository({ serverUrl: url });
    const a = w1.create({ body: 'w1' });
    const b = w2.create({ body: 'w2' });
    const [ma, mb] = await Promise.all([a, b]);
    await Promise.all([w1.updateBody(ma.id, 'w1-2'), w2.updateBody(mb.id, 'w2-2'), w1.setDraft('k', 'd')]);
    const ops = await w1.internal.backend.transact((tx) => tx.allOps());
    expect(ops).toHaveLength(2);
    expect(new Set(ops.map((o) => o.seq)).size).toBe(2);
    w1.close();
    w2.close();
  });

  it('IndexedDB 上で同期・競合が動く', async () => {
    const server = new MockServer();
    const url = uniqueUrl();
    const repo = await createIdbRepository({ serverUrl: url, dbName: 'cuenu-env-test' });
    const sync = createSyncController(repo, { serverUrl: url, token: 'tok', deviceId: 'D' }, server.fetch);
    const m = await repo.create({ body: 'v1' });
    await sync.syncNow();
    server.serverEdit(m.id, { body: 'other', version: 2 });
    await repo.updateBody(m.id, 'mine');
    await sync.syncNow();
    const c = await repo.get(m.id);
    expect(c?.conflict?.localBody).toBe('mine');
    expect(c?.body).toBe('other');
    repo.close();
  });
});
