// 画面内の共有コンテキスト（ナビゲーション・トースト・表示設定）。
import { createContext, useContext } from 'react';
import { DEFAULT_TIMEZONE } from './format';

export interface SearchPreset {
  keyword?: string;
  tags?: string[];
}

export interface NavApi {
  openThread(id: string): void;
  /** 返信 ID の場合は親スレッドを開く */
  openMemo(id: string): void;
  openSearch(preset?: SearchPreset): void;
  openSettings(): void;
  home(): void;
}

const noop = () => {};
export const NavContext = createContext<NavApi>({ openThread: noop, openMemo: noop, openSearch: noop, openSettings: noop, home: noop });
export const useNav = () => useContext(NavContext);

export interface ToastApi {
  show(message: string, action?: { label: string; run: () => void }): void;
}
export const ToastContext = createContext<ToastApi>({ show: noop });
export const useToast = () => useContext(ToastContext);

export interface DisplayPrefs {
  timezone: string;
}
export const PrefsContext = createContext<DisplayPrefs>({ timezone: DEFAULT_TIMEZONE });
export const usePrefs = () => useContext(PrefsContext);
