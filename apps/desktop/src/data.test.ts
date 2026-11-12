import 'fake-indexeddb/auto';
import { createIdbRepository } from '@cuenu/core/client';
import { describe, expect, it } from 'vitest';
import { adoptLocalMemos, openLocalRepository } from './data';

describe('adoptLocalMemos', () => {
  it('接続前に書いたメモを接続先へ未送信として移し、ローカル側からは消す', async () => {
    const local = await openLocalRepository(() => {});
    const p = await local.create({ body: '接続前のメモ' });
    await local.create({ body: '返信', parentId: p.id });
    local.close();

    const target = await createIdbRepository({ serverUrl: 'https://s.example', deviceId: 'mac' });
    expect(await adoptLocalMemos(target)).toBe(2);
    const moved = await target.get(p.id);
    expect(moved?.body).toBe('接続前のメモ');
    expect(moved?.syncState).toBe('pending');
    expect(await target.replies(p.id)).toHaveLength(1);
    expect(target.syncStatus().pendingOps).toBe(2);

    // 2 回目は何も移さない（二重取り込みしない）
    expect(await adoptLocalMemos(target)).toBe(0);
    target.close();
  });
});
