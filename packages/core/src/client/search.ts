// ローカル検索・ページング。正規化済み本文をキャッシュし、新しい順の配列を遅延ソートで保持する。

import type { SearchQuery } from '../repository';
import type { StoredMemo } from './backend';
import { normalizeText } from './util';

export interface SearchIndex {
  put(m: StoredMemo, old: StoredMemo | undefined): void;
  /** 新しい順（createdAt desc, id desc）で pred を満たすものを cursor の後ろから limit 件 */
  page(pred: (m: StoredMemo) => boolean, cursor: string | null, limit: number): {
    items: StoredMemo[];
    nextCursor: string | null;
  };
  matcher(q: SearchQuery, isVisible: (m: StoredMemo) => boolean): (m: StoredMemo) => boolean;
}

const cursorOf = (m: StoredMemo) => `${m.createdAt}|${m.id}`;

/** a が b より前（新しい）なら負 */
const cmp = (a: StoredMemo, b: StoredMemo) =>
  a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : a.id > b.id ? -1 : a.id < b.id ? 1 : 0;

export function createSearchIndex(): SearchIndex {
  const byId = new Map<string, StoredMemo>();
  const norm = new Map<string, string>();
  let sorted: StoredMemo[] = [];
  let dirty = false;

  const ensureSorted = () => {
    if (!dirty) return;
    sorted = [...byId.values()].sort(cmp);
    dirty = false;
  };

  /** cursor より後ろ（古い）の最初の位置 */
  const startIndex = (cursor: string | null) => {
    if (!cursor) return 0;
    // createdAt (ISO) は '|' を含まないので最初の '|' で分ける（id 側に '|' があっても壊れない）
    const sep = cursor.indexOf('|');
    if (sep < 0) return 0;
    const key = { createdAt: cursor.slice(0, sep), id: cursor.slice(sep + 1) } as StoredMemo;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cmp(sorted[mid]!, key) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  return {
    put(m, old) {
      byId.set(m.id, m);
      if (!old || old.body !== m.body) norm.set(m.id, normalizeText(m.body));
      if (old && !dirty && old.createdAt === m.createdAt) {
        // 並び順は不変なので配列内の参照だけ差し替える
        const i = startIndex(cursorOf(old)) - 1;
        if (sorted[i]?.id === m.id) {
          sorted[i] = m;
          return;
        }
      }
      dirty = true;
    },
    page(pred, cursor, limit) {
      ensureSorted();
      const n = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 500)) : 30;
      const items: StoredMemo[] = [];
      for (let i = startIndex(cursor); i < sorted.length; i++) {
        const m = sorted[i]!;
        if (!pred(m)) continue;
        if (items.length === n) return { items, nextCursor: cursorOf(items[n - 1]!) };
        items.push(m);
      }
      return { items, nextCursor: null };
    },
    matcher(q, isVisible) {
      const terms = q.keyword ? normalizeText(q.keyword).split(/\s+/).filter(Boolean) : [];
      const tags = q.tags?.filter(Boolean) ?? [];
      return (m) => {
        if (!isVisible(m)) return false;
        if (q.author && m.author !== q.author) return false;
        if (q.from && m.createdAt < q.from) return false;
        if (q.to && m.createdAt >= q.to) return false;
        for (const t of tags) if (!m.tags.includes(t)) return false;
        if (terms.length) {
          const text = norm.get(m.id) ?? '';
          for (const t of terms) if (!text.includes(t)) return false;
        }
        return true;
      };
    },
  };
}
