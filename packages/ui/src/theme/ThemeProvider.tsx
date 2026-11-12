import type { ThemePreference } from '@cuenu/core';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { THEME_STORAGE_KEY, applyTheme, readThemePreference, resolveTheme, systemPrefersDark, writeThemePreference } from './script';
import { THEME_TOKENS, type ResolvedTheme } from './tokens';

export interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference(p: ThemePreference): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeStorage {
  read(): ThemePreference;
  write(p: ThemePreference): void;
}

const defaultStorage: ThemeStorage = { read: readThemePreference, write: writeThemePreference };

/**
 * テーマ状態を管理し <html data-theme> を更新する。子要素は再マウントしないため入力内容・スクロール位置は保持される。
 */
export function ThemeProvider({ children, storage = defaultStorage }: { children: ReactNode; storage?: ThemeStorage }) {
  const [preference, setPref] = useState<ThemePreference>(() => storage.read());
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);

  useEffect(() => {
    const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);

  // 別ウィンドウ（Mac のクイック入力等）での変更に追従
  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) setPref(storage.read());
    };
    window.addEventListener('storage', on);
    return () => window.removeEventListener('storage', on);
  }, [storage]);

  const resolved = resolveTheme(preference, prefersDark);

  useEffect(() => {
    applyTheme(resolved);
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
    if (meta) meta.content = THEME_TOKENS[resolved].background;
  }, [resolved]);

  const setPreference = useCallback(
    (p: ThemePreference) => {
      storage.write(p);
      setPref(p);
    },
    [storage],
  );

  const value = useMemo(() => ({ preference, resolved, setPreference }), [preference, resolved, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error('useTheme must be used inside <ThemeProvider>');
  return v;
}
