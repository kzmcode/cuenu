// プラットフォーム注入。UI は MemoRepository / SyncController と、ここで定義する小さなアダプターだけに依存する。
import type {
  AiStatusResponse,
  ExportBundle,
  MemoRepository,
  SemanticSearchResponse,
  SyncController,
  UserSettings,
} from '@cuenu/core';
import { createContext, useContext, type ReactNode } from 'react';

/** ログイン・接続。未指定ならログイン UI を出さない（ローカルのみ） */
export interface AuthAdapter {
  isLoggedIn(): boolean;
  /** Mac 等、接続先 URL の入力が必要な場合 true（PWA は同一オリジンなので false） */
  requiresServerUrl?: boolean;
  serverUrl?(): string | null;
  login(input: { password: string; serverUrl?: string }): Promise<void>;
  logout(): Promise<void>;
  /** ログイン状態の変化を通知（任意） */
  subscribe?(listener: () => void): () => void;
}

/** オンライン時のみ使うサーバー機能。各メソッドは失敗時 throw */
export interface ServerAdapter {
  semanticSearch(query: string, limit?: number): Promise<SemanticSearchResponse>;
  aiStatus(): Promise<AiStatusResponse>;
  getSettings(): Promise<UserSettings>;
  putSettings(patch: Partial<UserSettings>): Promise<UserSettings>;
}

export type NotificationPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

/** 通知（PWA: Web Push、Mac: ネイティブ通知） */
export interface NotificationAdapter {
  permission(): NotificationPermissionState;
  /** 購読中か */
  isEnabled(): Promise<boolean>;
  /** ボタン操作から呼ぶ。権限要求→購読 */
  enable(): Promise<void>;
  disable(): Promise<void>;
  /** 利用できない理由（例: iPhone はホーム画面に追加が必要） */
  unsupportedReason?(): string | null;
}

/** ファイル保存（エクスポート）。未指定ならブラウザのダウンロードを使う */
export interface FileAdapter {
  saveJson(fileName: string, data: ExportBundle): Promise<void>;
}

export interface CuenuPlatform {
  repo: MemoRepository;
  sync?: SyncController | null;
  auth?: AuthAdapter | null;
  server?: ServerAdapter | null;
  notifications?: NotificationAdapter | null;
  files?: FileAdapter | null;
  /** この端末の deviceId（画像要約の元端末判定に使う）。不明なら null */
  deviceId?: string | null;
  /** 'web' | 'mac'。表示文言とナビ位置（web: 下部 / mac: 上部）の出し分けに使う */
  kind?: 'web' | 'mac';
  /** 画面の一部を撮影して画像として返す（Mac）。キャンセル時は null。未指定ならボタンを出さない */
  captureScreen?(): Promise<Blob | null>;
  /** オンライン判定。未指定なら navigator.onLine */
  isOnline?(): boolean;
}

const PlatformContext = createContext<CuenuPlatform | null>(null);

export function PlatformProvider({ platform, children }: { platform: CuenuPlatform; children: ReactNode }) {
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): CuenuPlatform {
  const p = useContext(PlatformContext);
  if (!p) throw new Error('usePlatform must be used inside <PlatformProvider>');
  return p;
}
