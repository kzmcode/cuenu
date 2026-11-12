import type { AuthorKind, SearchHit, SearchQuery } from '@cuenu/core';
import { useEffect, useId, useRef, useState } from 'react';
import { usePrefs, type SearchPreset } from '../context';
import { nextDay, zonedDayStartToUtc } from '../format';
import { useDebounced, useLoggedIn, useOnline, useRepoEvents } from '../hooks';
import { usePlatform } from '../platform';
import { CloseIcon, FilterIcon, SearchIcon } from './Icons';
import { MemoItem } from './MemoItem';

const SEARCH_PAGE_SIZE = 30;

type Mode = 'keyword' | 'semantic';

export interface SearchProps {
  preset?: { value: SearchPreset; at: number } | null;
  /** 検索語を外（Mac の左カラムの検索欄）から渡す場合。指定時はこの画面の検索欄を出さない */
  externalKeyword?: string;
}

export function Search({ preset, externalKeyword }: SearchProps) {
  const { repo, server, auth } = usePlatform();
  const { timezone } = usePrefs();
  const online = useOnline();
  const loggedIn = useLoggedIn();
  const [mode, setMode] = useState<Mode>('keyword');
  const [keyword, setKeyword] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [author, setAuthor] = useState<AuthorKind | ''>('');
  const [tags, setTags] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<{ tag: string; count: number }[]>([]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [semanticNote, setSemanticNote] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterId = useId();
  const [version, setVersion] = useState(0);
  const reqId = useRef(0);
  const debKeyword = useDebounced(keyword, 250);
  const external = externalKeyword !== undefined;
  useEffect(() => {
    if (externalKeyword !== undefined) setKeyword(externalKeyword);
  }, [externalKeyword]);

  useEffect(() => {
    if (!preset) return;
    setMode('keyword');
    if (preset.value.keyword !== undefined) setKeyword(preset.value.keyword);
    if (preset.value.tags) setTags(preset.value.tags);
  }, [preset]);

  useEffect(() => {
    repo.tags().then(setAllTags).catch(() => {});
  }, [repo, version]);

  useRepoEvents((e) => {
    if (e.type === 'memo-changed') setVersion((v) => v + 1);
  });

  const semanticReason = !server || !auth
    ? 'サーバーに接続していないため意味検索は使えません。キーワード検索を使ってください。'
    : !online
      ? 'オフラインのため意味検索は使えません。キーワード・日付・タグ検索は使えます。'
      : !loggedIn
        ? 'ログインしていないため意味検索は使えません。'
        : null;

  const buildQuery = (): SearchQuery => ({
    keyword: debKeyword.trim() || undefined,
    tags: tags.length ? tags : undefined,
    author: author || undefined,
    from: from ? (zonedDayStartToUtc(from, timezone) ?? undefined) : undefined,
    to: to ? (zonedDayStartToUtc(nextDay(to), timezone) ?? undefined) : undefined,
    limit: SEARCH_PAGE_SIZE,
  });

  const hasCondition = !!(debKeyword.trim() || tags.length || author || from || to);

  // キーワード検索（オフライン可）
  useEffect(() => {
    if (mode !== 'keyword') return;
    // 条件が変わったら実行中の検索結果は捨てる（条件を消した後に古い結果が出たり「検索中…」が残ったりしないように）
    const id = ++reqId.current;
    if (!hasCondition) {
      setHits([]);
      setCursor(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    repo
      .search(buildQuery())
      .then((p) => {
        if (id !== reqId.current) return;
        setHits(p.items.filter((h) => !h.memo.deletedAt));
        setCursor(p.nextCursor);
        setError(null);
      })
      .catch((e) => id === reqId.current && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => id === reqId.current && setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, mode, debKeyword, from, to, author, tags.join('\u0000'), timezone, version]);

  const more = async () => {
    if (!cursor) return;
    const id = reqId.current;
    setBusy(true);
    try {
      const p = await repo.search({ ...buildQuery(), cursor });
      if (id !== reqId.current) return;
      setHits((prev) => [...prev, ...p.items.filter((h) => !h.memo.deletedAt)]);
      setCursor(p.nextCursor);
    } catch (e) {
      if (id === reqId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === reqId.current) setBusy(false);
    }
  };

  const runSemantic = async () => {
    if (!server || semanticReason || !keyword.trim()) return;
    const id = ++reqId.current;
    setBusy(true);
    setError(null);
    try {
      const res = await server.semanticSearch(keyword.trim(), 20);
      const memos = await Promise.all(res.hits.map((h) => repo.get(h.memoId).catch(() => null)));
      if (id !== reqId.current) return;
      setHits(
        memos.flatMap((m) => (m && !m.deletedAt ? [{ memo: m, threadId: m.parentId ?? m.id }] : [])),
      );
      setCursor(null);
      setSemanticNote(res.pendingCount > 0 ? `索引作成待ちのメモが ${res.pendingCount} 件あります（索引済み ${res.indexedCount} 件）` : null);
    } catch (e) {
      if (id === reqId.current) setError(`意味検索に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (id === reqId.current) setBusy(false);
    }
  };

  const toggleTag = (t: string) => setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const activeFilters = (from || to ? 1 : 0) + (author ? 1 : 0);
  const authorLabel = author === 'user' ? '自分' : author === 'ai' ? 'AI' : '';
  const periodLabel = from || to ? `${from ? from.slice(5).replace('-', '/') : ''}〜${to ? to.slice(5).replace('-', '/') : ''}` : '';

  return (
    <section className="cu-search" aria-label="検索">
      {!external && (
      <form
        className="cu-searchbar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === 'semantic') void runSemantic();
        }}
      >
        <SearchIcon size={18} className="cu-searchbar-icon" />
        <input
          type="search"
          className="cu-searchbar-input"
          aria-label={mode === 'semantic' ? '探したい内容' : 'キーワード'}
          placeholder={mode === 'semantic' ? '例: 前に考えていたアプリ案' : 'メモを検索'}
          value={keyword}
          enterKeyHint="search"
          onChange={(e) => setKeyword(e.target.value)}
        />
        {keyword && (
          <button type="button" className="cu-searchbar-clear" aria-label="入力を消す" onClick={() => setKeyword('')}>
            <CloseIcon size={16} />
          </button>
        )}
        {mode === 'semantic' && (
          <button type="submit" className="cu-btn-primary cu-searchbar-go" disabled={!!semanticReason || !keyword.trim() || busy}>
            探す
          </button>
        )}
      </form>
      )}

      <div className="cu-search-tools">
        <div className="cu-segment" role="tablist" aria-label="検索の種類">
          <button type="button" role="tab" aria-selected={mode === 'keyword'} className="cu-segment-btn" onClick={() => setMode('keyword')}>
            キーワード
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'semantic'}
            className="cu-segment-btn"
            onClick={() => {
              if (mode === 'semantic') return;
              setMode('semantic');
              reqId.current++; // 実行中のキーワード検索の結果を意味検索の画面に出さない
              setBusy(false);
              setHits([]);
              setCursor(null);
            }}
          >
            意味検索
          </button>
        </div>
        {mode === 'semantic' && external && (
          <button type="button" className="cu-btn-primary cu-searchbar-go" disabled={!!semanticReason || !keyword.trim() || busy} onClick={() => void runSemantic()}>
            探す
          </button>
        )}
        {mode === 'keyword' && (
          <button
            type="button"
            className={'cu-filter-toggle' + (activeFilters ? ' cu-filter-toggle--active' : '')}
            aria-expanded={filtersOpen}
            aria-controls={filterId}
            onClick={() => setFiltersOpen((v) => !v)}
          >
            <FilterIcon size={16} />
            絞り込み{activeFilters ? <span className="cu-filter-count">{activeFilters}</span> : null}
          </button>
        )}
      </div>

      {mode === 'semantic' && (semanticReason || semanticNote) && (
        <p className={semanticReason ? 'cu-notice' : 'cu-meta-note'}>{semanticReason ?? semanticNote}</p>
      )}

      {mode === 'keyword' && filtersOpen && (
        <fieldset className="cu-filter-panel" id={filterId}>
          <legend className="cu-sr-only">絞り込み</legend>
          <div className="cu-filter-row">
            <span className="cu-filter-label">期間</span>
            <div className="cu-filter-dates">
              <input type="date" className="cu-date" aria-label="開始日" value={from} onChange={(e) => setFrom(e.target.value)} />
              <span aria-hidden="true">〜</span>
              <input type="date" className="cu-date" aria-label="終了日" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          <div className="cu-filter-row">
            <span className="cu-filter-label" id={filterId + '-author'}>投稿者</span>
            <div className="cu-segment cu-segment--small" role="group" aria-labelledby={filterId + '-author'}>
              {([['', 'すべて'], ['user', '自分'], ['ai', 'AI']] as const).map(([v, l]) => (
                <button key={l} type="button" className="cu-segment-btn" aria-pressed={author === v} onClick={() => setAuthor(v)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </fieldset>
      )}

      {mode === 'keyword' && !filtersOpen && activeFilters > 0 && (
        <div className="cu-chips" aria-label="適用中の絞り込み">
          {periodLabel && (
            <button type="button" className="cu-chip" aria-label={`期間 ${periodLabel} を解除`} onClick={() => { setFrom(''); setTo(''); }}>
              {periodLabel} <CloseIcon size={12} />
            </button>
          )}
          {authorLabel && (
            <button type="button" className="cu-chip" aria-label={`投稿者 ${authorLabel} を解除`} onClick={() => setAuthor('')}>
              {authorLabel} <CloseIcon size={12} />
            </button>
          )}
        </div>
      )}

      {mode === 'keyword' && allTags.length > 0 && (
        <div className="cu-tag-scroll" role="group" aria-label="タグ">
          {allTags.map(({ tag, count }) => (
            <button key={tag} type="button" className="cu-chip cu-chip--tag" aria-pressed={tags.includes(tag)} onClick={() => toggleTag(tag)}>
              #{tag}
              <span className="cu-chip-count">{count}</span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="cu-error" role="alert">
          {error}
        </p>
      )}
      <div className="cu-feed" aria-busy={busy} aria-live="polite">
        {hits.map((h) => (
          <MemoItem key={h.memo.id} memo={h.memo} mode="search" />
        ))}
      </div>
      {!busy && hits.length === 0 && (mode === 'keyword' ? hasCondition : false) && <p className="cu-empty">見つかりませんでした</p>}
      <div className="cu-feed-end">
        {busy ? (
          <span className="cu-meta-note">検索中…</span>
        ) : (
          cursor && (
            <button type="button" className="cu-btn" onClick={() => void more()}>
              さらに表示
            </button>
          )
        )}
      </div>
    </section>
  );
}
