// AI の新規トップレベル投稿を同期で受け取ったときに Mac のネイティブ通知を出す。
// 通常ウィンドウ（常駐。閉じても隠すだけ）の JS で1つだけ動かす。

import type { MemoRepository, MemoWithMeta, RepoEvent, SyncStatus } from '@cuenu/core';

export interface SeenStore {
  has(id: string): boolean;
  add(ids: string[]): void;
}

/** localStorage に直近の通知済みIDを保持（環境ごと）。同じ投稿を重複通知しない */
export function createSeenStore(envKey: string, storage: Pick<Storage, 'getItem' | 'setItem'>, max = 500): SeenStore {
  const key = `cuenu.desktop.notified.${envKey}`;
  let ids: string[] = [];
  try {
    ids = JSON.parse(storage.getItem(key) ?? '[]') as string[];
  } catch {
    ids = [];
  }
  const set = new Set(ids);
  return {
    has: (id) => set.has(id),
    add: (newIds) => {
      for (const id of newIds) {
        if (!set.has(id)) {
          set.add(id);
          ids.push(id);
        }
      }
      if (ids.length > max) {
        for (const id of ids.splice(0, ids.length - max)) set.delete(id);
      }
      try {
        storage.setItem(key, JSON.stringify(ids));
      } catch {
        /* 保存できなくても通知自体は続ける */
      }
    },
  };
}

export interface AiNotifierDeps {
  repo: Pick<MemoRepository, 'get' | 'subscribe'>;
  /** 同期状態（initialImportDone=false の間は通知しない） */
  syncStatus: () => SyncStatus | null;
  isEnabled: () => boolean;
  /** 本文の冒頭を通知に含めるか（既定 false。ロック画面に機微な内容を出さない） */
  showDetail?: () => boolean;
  notify: (title: string, body: string) => void | Promise<void>;
  seen: SeenStore;
}

function isNewAiPost(m: MemoWithMeta | null): m is MemoWithMeta {
  return !!m && m.author === 'ai' && m.parentId === null && m.deletedAt === null;
}

export function notificationText(posts: MemoWithMeta[], detail: boolean): { title: string; body: string } {
  if (posts.length === 1 && detail) {
    const text = posts[0]!.body.replace(/\s+/g, ' ').trim();
    return { title: 'Cuenu', body: text.length > 80 ? `${text.slice(0, 80)}…` : text };
  }
  return {
    title: 'Cuenu',
    body: posts.length === 1 ? '新しいAIの提案があります' : `新しいAIの提案が ${posts.length} 件あります`,
  };
}

/** 購読を開始し、解除関数を返す */
export function startAiNotifier(deps: AiNotifierDeps): () => void {
  let chain = Promise.resolve();
  const handle = async (e: RepoEvent) => {
    if (e.type !== 'memo-changed' || e.origin !== 'remote') return;
    const status = deps.syncStatus();
    const candidates = e.ids.filter((id) => !deps.seen.has(id));
    if (candidates.length === 0) return;
    const memos = await Promise.all(candidates.map((id) => deps.repo.get(id).catch(() => null)));
    const posts = memos.filter(isNewAiPost);
    if (posts.length === 0) return;
    // 初回取り込み中・通知無効時も既読扱いにして、後でまとめて古い投稿を通知しない
    deps.seen.add(posts.map((p) => p.id));
    if (!status?.initialImportDone || !deps.isEnabled()) return;
    const { title, body } = notificationText(posts, deps.showDetail?.() ?? false);
    await deps.notify(title, body);
  };
  return deps.repo.subscribe((e) => {
    chain = chain.then(() => handle(e)).catch(() => undefined);
  });
}

/** tauri-plugin-notification で通知（権限が無ければ要求） */
export async function tauriNotify(title: string, body: string): Promise<void> {
  const n = await import('@tauri-apps/plugin-notification');
  let granted = await n.isPermissionGranted();
  if (!granted) granted = (await n.requestPermission()) === 'granted';
  if (granted) n.sendNotification({ title, body });
}
