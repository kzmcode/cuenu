import type { MemoWithMeta } from '@cuenu/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRepoEvents } from '../hooks';
import { usePlatform } from '../platform';
import { MemoItem } from './MemoItem';

/** 1 回の読み込み件数（仮置き。docs/ui.md） */
const TIMELINE_PAGE_SIZE = 30;
/** これより下までスクロールしていたら新着を差し込まず「新しい投稿」を表示 */
const AT_TOP_PX = 80;

const isVisible = (m: MemoWithMeta | null): m is MemoWithMeta => !!m && !m.deletedAt;

export interface TimelineProps {
  /** スクロール位置の取得（既定 window.scrollY） */
  getScrollTop?(): number;
  scrollToTop?(): void;
}

export function Timeline({ getScrollTop = () => window.scrollY, scrollToTop = () => window.scrollTo?.({ top: 0 }) }: TimelineProps) {
  const { repo } = usePlatform();
  const [items, setItems] = useState<MemoWithMeta[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<MemoWithMeta[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const loadingRef = useRef(false);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const sentinel = useRef<HTMLDivElement>(null);

  const loadFirst = useCallback(async () => {
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await repo.timeline(null, TIMELINE_PAGE_SIZE);
      setItems(page.items.filter(isVisible));
      setCursor(page.nextCursor);
      setIncoming([]);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [repo]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await repo.timeline(cursor, TIMELINE_PAGE_SIZE);
      setItems((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...page.items.filter((m) => isVisible(m) && !seen.has(m.id))];
      });
      setCursor(page.nextCursor);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [repo, cursor]);

  // 段階読み込み
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) void loadMore();
    }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

  useRepoEvents((e) => {
    if (e.type !== 'memo-changed') return;
    void (async () => {
      const fetched = await Promise.all(e.ids.map((id) => repo.get(id).catch(() => null)));
      const parentIds = new Set<string>();
      const updates = new Map<string, MemoWithMeta | null>();
      const fresh: MemoWithMeta[] = [];
      fetched.forEach((m, i) => {
        const id = e.ids[i]!;
        if (m && m.parentId) {
          parentIds.add(m.parentId); // 返信はトップレベルに出さず、親の返信数だけ更新
          return;
        }
        if (itemsRef.current.some((x) => x.id === id)) updates.set(id, isVisible(m) ? m : null);
        else if (isVisible(m) && m.parentId === null) fresh.push(m);
      });
      for (const pid of parentIds) {
        if (itemsRef.current.some((x) => x.id === pid)) updates.set(pid, await repo.get(pid).catch(() => null));
      }
      if (updates.size) {
        const apply = (prev: MemoWithMeta[]) =>
          prev.flatMap((x) => {
            if (!updates.has(x.id)) return [x];
            const u = updates.get(x.id)!;
            return isVisible(u) ? [u] : [];
          });
        setItems(apply);
        setIncoming(apply);
      }
      if (fresh.length) {
        const cur = itemsRef.current;
        const top = cur[0]?.createdAt;
        const last = cur[cur.length - 1]?.createdAt;
        const newer = fresh.filter((m) => !top || m.createdAt > top);
        // 読み込み済み範囲内の過去分（初回取り込み等）はその位置へ。範囲外は段階読み込みで取得される
        const older = fresh.filter((m) => top && m.createdAt <= top && (!cursorRef.current || (last && m.createdAt >= last)));
        if (older.length) setItems((prev) => mergeNewest(prev, older));
        if (newer.length) {
          if (e.origin === 'local' || getScrollTop() < AT_TOP_PX) setItems((prev) => mergeNewest(prev, newer));
          else setIncoming((prev) => mergeNewest(prev, newer));
        }
      }
    })();
  });

  const showIncoming = () => {
    setItems((prev) => mergeNewest(prev, incoming));
    setIncoming([]);
    scrollToTop();
  };

  return (
    <section className="cu-timeline" aria-label="タイムライン">
      {incoming.length > 0 && (
        <div className="cu-new-posts">
          <button type="button" className="cu-btn-primary" onClick={showIncoming}>
            ↑ 新しい投稿 {incoming.length} 件
          </button>
        </div>
      )}
      {loadError && (
        <p className="cu-error" role="alert">
          読み込めませんでした: {loadError}{' '}
          <button type="button" className="cu-btn-text" onClick={() => void loadFirst()}>
            再読み込み
          </button>
        </p>
      )}
      <div className="cu-feed" role="feed" aria-busy={loading}>
        {items.map((m) => (
          <MemoItem key={m.id} memo={m} mode="timeline" />
        ))}
      </div>
      {!loading && items.length === 0 && !loadError && <p className="cu-empty">まだ投稿はありません</p>}
      <div ref={sentinel} className="cu-feed-end">
        {loading ? (
          <span className="cu-meta-note">読み込み中…</span>
        ) : (
          cursor && (
            <button type="button" className="cu-btn" onClick={() => void loadMore()}>
              さらに読み込む
            </button>
          )
        )}
      </div>
    </section>
  );
}

function mergeNewest(prev: MemoWithMeta[], add: MemoWithMeta[]): MemoWithMeta[] {
  const ids = new Set(add.map((m) => m.id));
  return [...add, ...prev.filter((m) => !ids.has(m.id))].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
