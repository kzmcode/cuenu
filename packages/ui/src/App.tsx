import type { LocalMemo, MemoRepository, UserSettings } from '@cuenu/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Composer } from './components/Composer';
import { Calendar, DayMemos } from './components/Calendar';
import { AlertIcon, BellIcon, CalendarIcon, CloudOffIcon, CloudUpIcon, ConflictIcon, HomeIcon, SearchIcon, SettingsIcon, SyncIcon } from './components/Icons';
import { Notifications, useUnreadAiCount } from './components/Notifications';
import { QuickInputView } from './components/QuickInput';
import { Search } from './components/Search';
import { Settings } from './components/Settings';
import { Thread } from './components/Thread';
import { Timeline } from './components/Timeline';
import { NavContext, PrefsContext, ToastContext, type NavApi, type SearchPreset, type ToastApi } from './context';
import { DEFAULT_TIMEZONE, dayKey } from './format';
import { useLoggedIn, useOnline, useSyncStatus } from './hooks';
import { PlatformProvider, usePlatform, type CuenuPlatform } from './platform';
import { ThemeProvider, type ThemeStorage } from './theme/ThemeProvider';

type View = 'home' | 'search' | 'calendar' | 'notifications' | 'settings' | 'thread';

export interface CuenuAppProps {
  platform: CuenuPlatform;
  /** 起動時に開くメモ（通知タップの /?memo=ID 等）。返信なら親スレッド */
  initialMemoId?: string | null;
  /** 起動後に外部からメモを開かせる（at を変えるたびに実行） */
  openRequest?: { memoId: string; at: number } | null;
  /** 本文欄の先頭に出すお知らせ（Mac: ログインが必要です 等）。左カラムを押し下げないよう本文欄の中に置く */
  notice?: ReactNode;
  /** 設定画面末尾に差し込む（Mac: 接続先・ショートカット等） */
  settingsExtra?: ReactNode;
  /** 表示タイムゾーンの初期値（サーバー設定取得後は自動更新） */
  timezone?: string;
  themeStorage?: ThemeStorage;
}

const TZ_KEY = 'cuenu.timezone';
function readTz(fallback: string): string {
  try {
    return localStorage.getItem(TZ_KEY) || fallback;
  } catch {
    return fallback;
  }
}

export function CuenuApp({ platform, themeStorage, ...rest }: CuenuAppProps) {
  return (
    <ThemeProvider storage={themeStorage}>
      <PlatformProvider platform={platform}>
        <AppShell {...rest} />
      </PlatformProvider>
    </ThemeProvider>
  );
}

function AppShell({ initialMemoId, openRequest, settingsExtra, notice, timezone: tzProp }: Omit<CuenuAppProps, 'platform' | 'themeStorage'>) {
  const { repo, auth, kind } = usePlatform();
  // PWA（web）は親指で届く下部ナビ、Mac は上部ナビ
  const navPosition: 'top' | 'bottom' = kind === 'mac' ? 'top' : 'bottom';
  // Mac で幅に余裕があるときは、検索・カレンダー・設定を左カラムに置く
  const wide = useMediaQuery('(min-width: 820px)');
  const sidebar = kind === 'mac' && wide;
  const [sidebarQuery, setSidebarQuery] = useState('');
  const [calendarDay, setCalendarDay] = useState<string | null>(null);
  const [view, setView] = useState<View>(initialMemoId ? 'thread' : 'home');
  const [threadId, setThreadId] = useState<string | null>(initialMemoId ?? null);
  const [returnView, setReturnView] = useState<Exclude<View, 'thread'>>('home');
  const [searchVisited, setSearchVisited] = useState(false);
  const [searchPreset, setSearchPreset] = useState<{ value: SearchPreset; at: number } | null>(null);
  const [timezone, setTimezone] = useState(() => readTz(tzProp ?? DEFAULT_TIMEZONE));
  const homeScroll = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;

  const go = useCallback((next: View) => {
    if (viewRef.current === 'home') homeScroll.current = window.scrollY;
    if (next === 'search') setSearchVisited(true);
    setView(next);
  }, []);

  useLayoutEffect(() => {
    if (view === 'home') window.scrollTo?.({ top: homeScroll.current });
    else window.scrollTo?.({ top: 0 });
  }, [view]);

  const nav = useMemo<NavApi>(
    () => ({
      openThread(id) {
        const cur = viewRef.current;
        if (cur !== 'thread') setReturnView(cur);
        setThreadId(id);
        go('thread');
      },
      openMemo(id) {
        void repo.get(id).then((m) => nav.openThread(m?.parentId ?? id), () => nav.openThread(id));
      },
      openSearch(preset) {
        if (preset) setSearchPreset({ value: preset, at: Date.now() });
        go('search');
      },
      openSettings: () => go('settings'),
      home: () => go('home'),
    }),
    [repo, go],
  );

  useEffect(() => {
    if (openRequest) nav.openMemo(openRequest.memoId);
  }, [openRequest, nav]);

  const [toast, setToast] = useState<{ id: number; message: string; action?: { label: string; run: () => void } } | null>(null);
  const toastApi = useMemo<ToastApi>(() => ({ show: (message, action) => setToast({ id: Date.now(), message, action }) }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  const onSettingsLoaded = useCallback((s: UserSettings) => {
    setTimezone(s.timezone);
    try {
      localStorage.setItem(TZ_KEY, s.timezone);
    } catch {
      /* noop */
    }
  }, []);

  const prefs = useMemo(() => ({ timezone }), [timezone]);

  const navEl = (
    <nav className={`cu-nav cu-nav--${navPosition}`} aria-label="メイン">
      <NavButton label="ホーム" current={view === 'home'} onClick={() => go('home')}>
        <HomeIcon size={22} />
      </NavButton>
      <NavButton label="カレンダー" current={view === 'calendar'} onClick={() => go('calendar')}>
        <CalendarIcon size={22} />
      </NavButton>
      <NavButton label="検索" current={view === 'search'} onClick={() => go('search')}>
        <SearchIcon size={22} />
      </NavButton>
      <NavButton label="設定" current={view === 'settings'} onClick={() => go('settings')}>
        <SettingsIcon size={22} />
      </NavButton>
    </nav>
  );

  return (
    <NavContext.Provider value={nav}>
      <ToastContext.Provider value={toastApi}>
        <PrefsContext.Provider value={prefs}>
          <div className={sidebar ? 'cu-app cu-app--sidebar' : `cu-app cu-app--nav-${navPosition}`}>
            {sidebar ? (
              <aside className="cu-sidebar" aria-label="サイドバー">
                <div className="cu-sidebar-head">
                  <h1 className="cu-logo">
                    <button type="button" className="cu-logo-btn" onClick={() => go('home')}>
                      Cuenu
                    </button>
                  </h1>
                  <SyncIndicator onClick={() => go('settings')} />
                </div>
                <form
                  className="cu-searchbar cu-searchbar--side"
                  role="search"
                  onSubmit={(e) => {
                    e.preventDefault();
                    go('search');
                  }}
                >
                  <SearchIcon size={16} className="cu-searchbar-icon" />
                  <input
                    type="search"
                    className="cu-searchbar-input"
                    aria-label="キーワード"
                    placeholder="メモを検索"
                    value={sidebarQuery}
                    onChange={(e) => {
                      setSidebarQuery(e.target.value);
                      if (e.target.value.trim()) go('search');
                    }}
                    onFocus={() => sidebarQuery.trim() && go('search')}
                  />
                </form>
                <nav className="cu-side-nav" aria-label="メイン">
                  <SideItem label="タイムライン" current={view === 'home'} onClick={() => go('home')} icon={<HomeIcon size={18} />} />
                  <SideNotifications current={view === 'notifications'} onClick={() => go('notifications')} />
                  <SideItem label="検索" current={view === 'search'} onClick={() => go('search')} icon={<SearchIcon size={18} />} />
                </nav>
                <Calendar
                  variant="sidebar"
                  selected={view === 'calendar' && calendarDay ? calendarDay : undefined}
                  onSelect={(d) => {
                    setCalendarDay(d);
                    go('calendar');
                  }}
                />
                <div className="cu-sidebar-foot">
                  <button
                    type="button"
                    className="cu-side-icon"
                    aria-label="設定"
                    title="設定"
                    aria-current={view === 'settings' ? 'page' : undefined}
                    onClick={() => go('settings')}
                  >
                    <SettingsIcon size={20} />
                  </button>
                </div>
              </aside>
            ) : (
            <header className="cu-header">
              <h1 className="cu-logo">
                <button type="button" className="cu-logo-btn" onClick={() => go('home')}>
                  Cuenu
                </button>
              </h1>
              <SyncIndicator onClick={() => go('settings')} />
              {navPosition === 'top' && navEl}
              <BellButton current={view === 'notifications'} onClick={() => go('notifications')} />
            </header>
            )}
            <main className="cu-main">
              {notice}
              {/* ホームと検索は表示を切り替えても状態（下書き・検索条件）を保持するため常駐させる */}
              <div hidden={view !== 'home'}>
                <Composer draftKey="main" autoFocus={!initialMemoId} />
                {/* 本文欄の先頭にお知らせ（Mac のログイン案内）がある場合は重ねて出さない */}
                {auth && !notice && <LoginNotice onLogin={() => go('settings')} />}
                <Timeline />
              </div>
              {searchVisited && (
                <div hidden={view !== 'search'}>
                  <Search preset={searchPreset} externalKeyword={sidebar ? sidebarQuery : undefined} />
                </div>
              )}
              {view === 'calendar' && (sidebar ? <DayMemos day={calendarDay ?? todayKey(timezone)} /> : <Calendar />)}
              {view === 'notifications' && <Notifications />}
              {view === 'settings' && <Settings extra={settingsExtra} onSettingsLoaded={onSettingsLoaded} />}
              {view === 'thread' && threadId && <Thread key={threadId} threadId={threadId} onBack={() => go(returnView)} />}
            </main>
            {!sidebar && navPosition === 'bottom' && navEl}
            <div className="cu-toast-region" role="status" aria-live="polite">
              {toast && (
                <div className="cu-toast">
                  <span>{toast.message}</span>
                  {toast.action && (
                    <button
                      type="button"
                      className="cu-btn-text"
                      onClick={() => {
                        toast.action!.run();
                        setToast(null);
                      }}
                    >
                      {toast.action.label}
                    </button>
                  )}
                  <button type="button" className="cu-btn-text" aria-label="閉じる" onClick={() => setToast(null)}>
                    ×
                  </button>
                </div>
              )}
            </div>
          </div>
        </PrefsContext.Provider>
      </ToastContext.Provider>
    </NavContext.Provider>
  );
}

function NavButton({ label, current, onClick, children }: { label: string; current: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" className="cu-nav-btn" aria-label={label} title={label} aria-current={current ? 'page' : undefined} onClick={onClick}>
      {children}
    </button>
  );
}

function SideItem({ label, current, onClick, icon, badge }: { label: string; current: boolean; onClick(): void; icon: ReactNode; badge?: number }) {
  return (
    <button type="button" className="cu-side-item" aria-current={current ? 'page' : undefined} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {badge ? (
        <span className="cu-side-badge" aria-label={`未読 ${badge} 件`}>
          {badge > 9 ? '9+' : badge}
        </span>
      ) : null}
    </button>
  );
}

function SideNotifications({ current, onClick }: { current: boolean; onClick(): void }) {
  const unread = useUnreadAiCount();
  return <SideItem label="AIの投稿" current={current} onClick={onClick} icon={<BellIcon size={18} />} badge={unread} />;
}

function useMediaQuery(q: string): boolean {
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(q).matches : false);
  const [v, setV] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(q);
    const on = () => setV(m.matches);
    on();
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, [q]);
  return v;
}

function todayKey(tz: string): string {
  return dayKey(new Date().toISOString(), tz);
}

function BellButton({ current, onClick }: { current: boolean; onClick(): void }) {
  const unread = useUnreadAiCount();
  const label = unread > 0 ? `AIの投稿（未読 ${unread} 件）` : 'AIの投稿';
  return (
    <button type="button" className="cu-bell" aria-label={label} title={label} aria-current={current ? 'page' : undefined} onClick={onClick}>
      <BellIcon size={22} />
      {unread > 0 && (
        <span className="cu-bell-badge" aria-hidden="true">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </button>
  );
}

function SyncIndicator({ onClick }: { onClick(): void }) {
  const status = useSyncStatus();
  const online = useOnline();
  let state: { label: string; icon: ReactNode; count?: number; error?: boolean } | null = null;
  if (!online) state = { label: 'オフライン', icon: <CloudOffIcon size={18} /> };
  else if (status?.conflicts) state = { label: `競合 ${status.conflicts} 件`, icon: <ConflictIcon size={18} />, count: status.conflicts, error: true };
  else if (status?.lastError) state = { label: '同期失敗', icon: <AlertIcon size={18} />, error: true };
  else if (status?.syncing) state = { label: '同期中', icon: <SyncIcon size={18} className="cu-spin" /> };
  else if (status?.pendingOps) state = { label: `同期待ち ${status.pendingOps} 件`, icon: <CloudUpIcon size={18} />, count: status.pendingOps };
  if (!state) return <span className="cu-header-spacer" />;
  return (
    <span className="cu-header-spacer cu-sync-slot">
      <button
        type="button"
        className={'cu-sync-indicator' + (state.error ? ' cu-status-icon--error' : '')}
        aria-label={`${state.label}（設定を開く）`}
        title={state.label}
        onClick={onClick}
      >
        {state.icon}
        {state.count ? <span className="cu-icon-count">{state.count}</span> : null}
      </button>
    </span>
  );
}

function LoginNotice({ onLogin }: { onLogin(): void }) {
  const loggedIn = useLoggedIn();
  if (loggedIn) return null;
  return (
    <p className="cu-notice">
      サーバー未接続です。投稿はこの端末に保存されます。{' '}
      <button type="button" className="cu-link" onClick={onLogin}>
        ログイン
      </button>
    </p>
  );
}

export interface CuenuQuickInputProps {
  platform?: CuenuPlatform;
  /** platform の代わりに repo だけ渡してもよい */
  repo?: MemoRepository;
  draftKey?: string;
  onPosted?(memo: LocalMemo): void;
  /** onPosted の別名 */
  onSubmitted?(memo: LocalMemo): void;
  /** Esc。下書きは保存済み */
  onDismiss?(): void;
  /** onDismiss の別名 */
  onCancel?(): void;
  /** 値が変わるたびに入力欄へフォーカス（ウィンドウ再表示時に増やす） */
  focusSignal?: number;
  themeStorage?: ThemeStorage;
}

/** Mac クイック入力ウィンドウ用。テーマ・プラットフォーム Provider を内包 */
export function CuenuQuickInput({ platform, repo, draftKey, onPosted, onSubmitted, onDismiss, onCancel, focusSignal, themeStorage }: CuenuQuickInputProps) {
  const p = useMemo<CuenuPlatform>(() => platform ?? { repo: repo! }, [platform, repo]);
  if (!p.repo) throw new Error('CuenuQuickInput: platform か repo が必要です');
  return (
    <ThemeProvider storage={themeStorage}>
      <PlatformProvider platform={p}>
        <QuickInputView
          draftKey={draftKey}
          focusSignal={focusSignal}
          onPosted={(m) => {
            onPosted?.(m);
            onSubmitted?.(m);
          }}
          onDismiss={() => {
            onDismiss?.();
            onCancel?.();
          }}
        />
      </PlatformProvider>
    </ThemeProvider>
  );
}
