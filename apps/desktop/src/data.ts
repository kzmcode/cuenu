// @cuenu/core/client（担当B）との結線。
// ローカル DB は B の createIdbRepository が serverUrl ごとに分離する（cuenu:<hash(serverUrl)>）。
// 両ウィンドウは同一オリジンなので同じ DB を開き、変更は B の BroadcastChannel で相互に反映される。
// 同期エンジンは通常ウィンドウだけで動かす（クイック入力は repo のみ。B は複数ウィンドウでの同期も Web Locks で1本化）。

import type { ConnectionConfig } from '@cuenu/core';
import { createIdbRepository, createSyncController, type CuenuSyncController, type IdbRepository } from '@cuenu/core/client';
import type { EnvConfig } from './native';

export type DesktopRepo = IdbRepository;
export type DesktopSync = CuenuSyncController;

export async function openRepository(env: EnvConfig, onVersionChange?: () => void): Promise<DesktopRepo> {
  return createIdbRepository({
    serverUrl: env.serverUrl,
    deviceId: env.deviceId,
    onVersionChange: onVersionChange ?? (() => window.location.reload()),
  });
}

export function createSync(repo: DesktopRepo, config: ConnectionConfig): DesktopSync {
  return createSyncController(repo, config, (input, init) => fetch(input, init));
}

/**
 * 接続設定前の記録先（cuenu:local）。要件「未通信でも投稿できる」のため、
 * 初回接続前でもクイック入力からローカル保存できるようにする。
 */
export async function openLocalRepository(onVersionChange?: () => void): Promise<DesktopRepo> {
  return createIdbRepository({ onVersionChange: onVersionChange ?? (() => window.location.reload()) });
}

/**
 * 接続前に書いたメモを接続先の環境へ移す（新規の未送信として積む）。
 * 取り込みが成功したものだけローカル側から削除する。失敗時はローカルに残る。
 * 要約待ちの元画像は移さない（本文のみ）。
 */
export async function adoptLocalMemos(target: DesktopRepo): Promise<number> {
  const local = await openLocalRepository(() => {});
  try {
    const bundle = await local.exportAll();
    const memos = bundle.memos.filter((m) => !m.deletedAt && m.author === 'user');
    if (memos.length === 0) return 0;
    const { imported } = await target.importBundle({ ...bundle, memos });
    for (const m of memos) {
      if (m.parentId) continue; // 返信は親の削除で消える
      if (await target.get(m.id)) await local.remove(m.id).catch(() => {});
    }
    return imported;
  } finally {
    local.close();
  }
}
