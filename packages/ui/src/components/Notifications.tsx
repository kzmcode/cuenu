// 通知: AI の投稿だけを新しい順に表示する。最後に開いた時刻より新しい AI 投稿を未読として数える（端末ごと）
import type { MemoWithMeta } from '@cuenu/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRepoEvents } from '../hooks';
import { usePlatform } from '../platform';
import { MemoItem } from './MemoItem';

const SEEN_KEY = 'cuenu.aiSeenAt';
const PAGE = 30;

function readSeen(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    return '';
  }
}
function writeSeen(iso: string) {
  try {
    localStorage.setItem(SEEN_KEY, iso);
  } catch {
    /* noop */
  }
  window.dispatchEvent(new Event('cuenu:ai-seen'));
}

/** 未読の AI 投稿数（最後に通知画面を開いた時刻より新しいもの） */
export function useUnreadAiCount(): number {
  const { repo } = usePlatform();
  const [count, setCount] = useState(0);
  const reqId = useRef(0);
  const refresh = useCallback(async () => {
    // 更新が重なったとき、古い集計で上書きしない
    const id = ++reqId.current;
    const done = (n: number) => {
      if (id === reqId.current) setCount(n);
    };
    const seen = readSeen();
    let n = 0;
    let cursor: string | null = null;
    // 未読は多くても数件の想定。新しい順に読み、既読に達したら打ち切る
    do {
      const page = await repo.search({ author: 'ai', cursor, limit: PAGE });
      for (const h of page.items) {
        if (h.memo.deletedAt || h.memo.parentId) continue;
        if (seen && h.memo.createdAt <= seen) return done(n);
        n++;
      }
      cursor = page.nextCursor;
    } while (cursor && n < 99);
    done(n);
  }, [repo]);
  useEffect(() => {
    void refresh().catch(() => {});
    const on = () => void refresh().catch(() => {});
    window.addEventListener('cuenu:ai-seen', on);
    return () => window.removeEventListener('cuenu:ai-seen', on);
  }, [refresh]);
  useRepoEvents((e) => {
    if (e.type === 'memo-changed') void refresh().catch(() => {});
  });
  return count;
}

export function Notifications() {
  const { repo } = usePlatform();
  const [items, setItems] = useState<MemoWithMeta[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [version, setVersion] = useState(0);
  // 開いた時点の既読時刻（この画面では、それより新しいものに「新着」印を付ける）
  const seenAtOpen = useRef(readSeen());

  useRepoEvents((e) => {
    if (e.type === 'memo-changed') setVersion((v) => v + 1);
  });

  useEffect(() => {
    let alive = true;
    setBusy(true);
    repo
      .search({ author: 'ai', limit: PAGE })
      .then((p) => {
        if (!alive) return;
        const list = p.items.map((h) => h.memo).filter((m) => !m.deletedAt && !m.parentId);
        setItems(list);
        setCursor(p.nextCursor);
        if (list[0]) writeSeen(list[0].createdAt > readSeen() ? list[0].createdAt : readSeen());
      })
      .catch(() => alive && setItems([]))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [repo, version]);

  const more = async () => {
    if (!cursor) return;
    try {
      const p = await repo.search({ author: 'ai', cursor, limit: PAGE });
      setItems((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...p.items.map((h) => h.memo).filter((m) => !m.deletedAt && !m.parentId && !seen.has(m.id))];
      });
      setCursor(p.nextCursor);
    } catch {
      // 失敗時は「さらに表示」を残して再試行できるようにする
    }
  };

  return (
    <section className="cu-notifications" aria-label="AIの投稿">
      <div className="cu-feed">
        {items.map((m) => (
          <div key={m.id} className={seenAtOpen.current && m.createdAt > seenAtOpen.current ? 'cu-unread' : undefined}>
            <MemoItem memo={m} />
          </div>
        ))}
      </div>
      {!busy && items.length === 0 && <p className="cu-empty">AIの投稿はまだありません</p>}
      <div className="cu-feed-end">
        {cursor && (
          <button type="button" className="cu-btn" onClick={() => void more()}>
            さらに表示
          </button>
        )}
      </div>
    </section>
  );
}
