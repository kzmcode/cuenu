// カレンダー: 月ごとに記録のある日を示し、選んだ日に書いたメモ・返信・AI 投稿を表示する（端末内データのみで動く）
import type { SearchHit } from '@cuenu/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePrefs } from '../context';
import { dayKey, formatDayLabel, nextDay, zonedDayStartToUtc } from '../format';
import { useRepoEvents } from '../hooks';
import { usePlatform } from '../platform';
import { ChevronIcon } from './Icons';
import { MemoItem } from './MemoItem';

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const PAGE = 500;

const pad = (n: number) => String(n).padStart(2, '0');
const monthKey = (y: number, m: number) => `${y}-${pad(m)}`;

export interface CalendarProps {
  /** full: 月表示＋選んだ日の一覧（PWA）／ sidebar: 月表示だけの小さな版（Mac の左カラム） */
  variant?: 'full' | 'sidebar';
  /** 選択中の日を外から制御する場合 */
  selected?: string;
  onSelect?(day: string): void;
}

export function Calendar({ variant = 'full', selected: selectedProp, onSelect }: CalendarProps = {}) {
  const { repo } = usePlatform();
  const { timezone } = usePrefs();
  const today = dayKey(new Date().toISOString(), timezone);
  const [ym, setYm] = useState(() => (selectedProp ?? today).slice(0, 7));
  const [selectedState, setSelectedState] = useState(today);
  const selected = selectedProp ?? selectedState;
  const setSelected = (d: string) => {
    setSelectedState(d);
    onSelect?.(d);
  };
  const compact = variant === 'sidebar';
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const req = useRef(0);

  useRepoEvents((e) => {
    if (e.type === 'memo-changed') setVersion((v) => v + 1);
  });

  const [y, m] = ym.split('-').map(Number) as [number, number];

  // 表示中の月の記録をまとめて取得（タイムゾーンの月初〜翌月初）
  useEffect(() => {
    const id = ++req.current;
    const next = m === 12 ? monthKey(y + 1, 1) : monthKey(y, m + 1);
    const from = zonedDayStartToUtc(`${ym}-01`, timezone) ?? undefined;
    const to = zonedDayStartToUtc(`${next}-01`, timezone) ?? undefined;
    setBusy(true);
    (async () => {
      const all: SearchHit[] = [];
      let cursor: string | null = null;
      do {
        const page = await repo.search({ from, to, cursor, limit: PAGE });
        all.push(...page.items.filter((h) => !h.memo.deletedAt));
        cursor = page.nextCursor;
      } while (cursor && all.length < 5000);
      if (id === req.current) setHits(all);
    })()
      .catch(() => id === req.current && setHits([]))
      .finally(() => id === req.current && setBusy(false));
  }, [repo, ym, y, m, timezone, version]);

  const byDay = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const h of hits) {
      const k = dayKey(h.memo.createdAt, timezone);
      const list = map.get(k) ?? [];
      list.push(h);
      map.set(k, list);
    }
    // その日の中は古い順（日記として読む）
    for (const list of map.values()) list.sort((a, b) => a.memo.createdAt.localeCompare(b.memo.createdAt));
    return map;
  }, [hits, timezone]);

  const cells = useMemo(() => {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return [...Array<null>(first).fill(null), ...Array.from({ length: days }, (_, i) => `${ym}-${pad(i + 1)}`)];
  }, [y, m, ym]);

  const shift = (delta: number) => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    const next = monthKey(d.getUTCFullYear(), d.getUTCMonth() + 1);
    setYm(next);
    // 小さな版は月をめくるだけで選択日は変えない（一覧が勝手に切り替わらないように）
    if (!compact) setSelected(next === today.slice(0, 7) ? today : `${next}-01`);
  };

  const list = byDay.get(selected) ?? [];
  const max = Math.max(1, ...[...byDay.values()].map((l) => l.length));

  return (
    <section className={'cu-calendar' + (compact ? ' cu-calendar--compact' : '')} aria-label="カレンダー">
      <div className="cu-cal-head">
        <button type="button" className="cu-btn-text cu-icon-action" aria-label="前の月" onClick={() => shift(-1)}>
          <ChevronIcon dir="left" size={compact ? 16 : 20} />
        </button>
        <h2 className="cu-cal-title" aria-live="polite">
          {y}年{m}月
        </h2>
        <button type="button" className="cu-btn-text cu-icon-action" aria-label="次の月" onClick={() => shift(1)}>
          <ChevronIcon size={compact ? 16 : 20} />
        </button>
        {(ym !== today.slice(0, 7) || selected !== today) && (
          <button
            type="button"
            className="cu-btn-text cu-cal-today"
            onClick={() => {
              setYm(today.slice(0, 7));
              setSelected(today);
            }}
          >
            今日
          </button>
        )}
      </div>

      <div className="cu-cal-grid" role="group" aria-label={`${y}年${m}月の日付`} aria-busy={busy}>
        <div className="cu-cal-row" aria-hidden="true">
          {WEEK.map((w, i) => (
            <span key={w} className={'cu-cal-week' + (i === 0 ? ' cu-cal--sun' : i === 6 ? ' cu-cal--sat' : '')}>
              {w}
            </span>
          ))}
        </div>
        <div className="cu-cal-days">
          {cells.map((k, i) => {
            if (!k) return <span key={`e${i}`} className="cu-cal-day cu-cal-day--empty" />;
            const count = byDay.get(k)?.length ?? 0;
            const hasAi = byDay.get(k)?.some((h) => h.memo.author === 'ai') ?? false;
            const level = count === 0 ? 0 : Math.min(3, Math.ceil((count / max) * 3));
            return (
              <button
                key={k}
                type="button"
                className={
                  'cu-cal-day' +
                  (k === selected ? ' cu-cal-day--selected' : '') +
                  (k === today ? ' cu-cal-day--today' : '') +
                  (k > today ? ' cu-cal-day--future' : '')
                }
                aria-pressed={k === selected}
                aria-label={`${formatDayLabel(k)} ${count ? `${count} 件` : '記録なし'}`}
                onClick={() => setSelected(k)}
              >
                <span className="cu-cal-num">{Number(k.slice(8))}</span>
                <span className={`cu-cal-dot cu-cal-dot--l${level}`} aria-hidden="true">
                  {hasAi && <span className="cu-cal-ai" />}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {!compact && (
        <>
      <h3 className="cu-cal-daytitle">
        {formatDayLabel(selected)}
        <span className="cu-meta-note">{list.length ? ` ${list.length} 件` : ''}</span>
      </h3>
      <div className="cu-feed">
        {list.map((h) => (
          <MemoItem key={h.memo.id} memo={h.memo} mode="search" />
        ))}
      </div>
      {!busy && list.length === 0 && <p className="cu-empty">この日の記録はありません</p>}
        </>
      )}
    </section>
  );
}


/** 指定した日に書いたメモ・返信・AI 投稿（古い順）。Mac の左カラムで日を選んだときの本文側 */
export function DayMemos({ day }: { day: string }) {
  const { repo } = usePlatform();
  const { timezone } = usePrefs();
  const [list, setList] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(true);
  const [version, setVersion] = useState(0);
  useRepoEvents((e) => {
    if (e.type === 'memo-changed') setVersion((v) => v + 1);
  });
  useEffect(() => {
    let alive = true;
    const from = zonedDayStartToUtc(day, timezone) ?? undefined;
    const to = zonedDayStartToUtc(nextDay(day), timezone) ?? undefined;
    setBusy(true);
    repo
      .search({ from, to, limit: PAGE })
      .then((p) => {
        if (!alive) return;
        setList(p.items.filter((h) => !h.memo.deletedAt).sort((a, b) => a.memo.createdAt.localeCompare(b.memo.createdAt)));
      })
      .catch(() => alive && setList([]))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [repo, day, timezone, version]);
  return (
    <section className="cu-day" aria-label={formatDayLabel(day)}>
      <h2 className="cu-view-title">
        {formatDayLabel(day)}
        <span className="cu-meta-note">{list.length ? ` ${list.length} 件` : ''}</span>
      </h2>
      <div className="cu-feed">
        {list.map((h) => (
          <MemoItem key={h.memo.id} memo={h.memo} mode="search" />
        ))}
      </div>
      {!busy && list.length === 0 && <p className="cu-empty">この日の記録はありません</p>}
    </section>
  );
}
