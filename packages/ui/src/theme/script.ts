// テーマ設定の端末保存と、初回描画前に解決するインラインスクリプト。
// React を import しない（index.html への埋め込み・Mac の初期化でも使えるように）。
import type { ThemePreference } from '@cuenu/core';
import type { ResolvedTheme } from './tokens';

export const THEME_STORAGE_KEY = 'cuenu.theme';

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === 'system' || v === 'light' || v === 'dark';
}

export function readThemePreference(): ThemePreference {
  try {
    const v = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

export function writeThemePreference(p: ThemePreference): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, p);
  } catch {
    // 保存できない環境（プライベートモード等）はその場の切替のみ
  }
}

export function systemPrefersDark(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  } catch {
    return false;
  }
}

export function resolveTheme(p: ThemePreference, prefersDark = systemPrefersDark()): ResolvedTheme {
  if (p === 'light' || p === 'dark') return p;
  return prefersDark ? 'dark' : 'light';
}

/** <html data-theme> と color-scheme を設定 */
export function applyTheme(theme: ResolvedTheme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/**
 * <head> に <script> として埋め込む文字列。CSS より前に実行して反対テーマのちらつきを防ぐ。
 * 例: `<script>${getThemeInitScript()}</script>`
 */
export function getThemeInitScript(storageKey: string = THEME_STORAGE_KEY): string {
  // <script> 内に埋め込むため、キーに含まれる "<" を JSON のエスケープにして </script> での脱出を防ぐ
  const key = JSON.stringify(storageKey).replace(/</g, '\\u003c');
  return `(function(){try{var p=localStorage.getItem(${key});}catch(e){}if(p!=="light"&&p!=="dark"){p=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}var r=document.documentElement;r.setAttribute("data-theme",p);r.style.colorScheme=p;})();`;
}
