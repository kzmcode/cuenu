// Rust（src-tauri/src/lib.rs）の Tauri command への薄いラッパー。
// テストや、Tauri 外のブラウザで `vite dev` を開いた時のために NativeBridge を差し替え可能にしている。

export interface EnvConfig {
  serverUrl: string;
  envKey: string;
  deviceId: string;
}

export interface DesktopSettings {
  format: number;
  /** global-hotkey 形式（例 "Control+Super+M"） */
  shortcut: string;
  notificationsEnabled: boolean;
  active: EnvConfig | null;
  known: EnvConfig[];
  shortcutRegistered: boolean;
  shortcutError: string | null;
  defaultShortcut: string;
}

export interface NativeBridge {
  readonly isTauri: boolean;
  getSettings(): Promise<DesktopSettings>;
  /** 登録できなければ reject（旧設定は維持される） */
  setShortcut(accelerator: string): Promise<DesktopSettings>;
  setNotificationsEnabled(enabled: boolean): Promise<DesktopSettings>;
  setActiveConnection(env: EnvConfig | null): Promise<DesktopSettings>;
  setToken(envKey: string, token: string): Promise<void>;
  getToken(envKey: string): Promise<string | null>;
  deleteToken(envKey: string): Promise<void>;
  hideQuick(): Promise<void>;
  /** ショートカット記録中は、いまのグローバルショートカットを一時的に外す */
  pauseShortcut?(): Promise<void>;
  resumeShortcut?(): Promise<void>;
  /** 画面の一部を撮影（macOS の範囲選択）。PNG。キャンセル時は null。Tauri 外では未対応 */
  captureScreen?(): Promise<Blob | null>;
  /** Rust からのイベント購読。戻り値で解除 */
  listen(event: NativeEvent, handler: () => void): Promise<() => void>;
}

export type NativeEvent = 'quick:shown' | 'quick:close-requested' | 'connection:changed';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function createTauriBridge(): Promise<NativeBridge> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  return {
    isTauri: true,
    getSettings: () => invoke('get_settings'),
    setShortcut: (accelerator) => invoke('set_shortcut', { accelerator }),
    setNotificationsEnabled: (enabled) => invoke('set_notifications_enabled', { enabled }),
    setActiveConnection: (env) => invoke('set_active_connection', { env }),
    setToken: (envKey, token) => invoke('secret_set_token', { envKey, token }),
    getToken: (envKey) => invoke('secret_get_token', { envKey }),
    deleteToken: (envKey) => invoke('secret_delete_token', { envKey }),
    hideQuick: () => invoke('hide_quick'),
    pauseShortcut: () => invoke('pause_shortcut'),
    resumeShortcut: () => invoke('resume_shortcut'),
    captureScreen: async () => {
      const buf = await invoke<ArrayBuffer>('capture_screen');
      return buf && buf.byteLength > 0 ? new Blob([buf], { type: 'image/png' }) : null;
    },
    listen: async (event, handler) => listen(event, () => handler()),
  };
}

/**
 * Tauri 外（通常ブラウザでの画面確認）用。トークンを localStorage に置くので開発専用。
 * 配布ビルドでは使わない。
 */
export function createBrowserDevBridge(storage: Storage = localStorage): NativeBridge {
  const KEY = 'cuenu.desktop.dev-settings';
  const defaults: DesktopSettings = {
    format: 1,
    shortcut: 'Control+Super+M',
    notificationsEnabled: true,
    active: null,
    known: [],
    shortcutRegistered: false,
    shortcutError: 'ブラウザ開発モードではグローバルショートカットは無効です',
    defaultShortcut: 'Control+Super+M',
  };
  const read = (): DesktopSettings => {
    try {
      return { ...defaults, ...(JSON.parse(storage.getItem(KEY) ?? '{}') as Partial<DesktopSettings>) };
    } catch {
      return defaults;
    }
  };
  const write = (patch: Partial<DesktopSettings>) => {
    const next = { ...read(), ...patch };
    storage.setItem(KEY, JSON.stringify(next));
    return next;
  };
  const listeners = new Map<NativeEvent, Set<() => void>>();
  const emit = (e: NativeEvent) => listeners.get(e)?.forEach((h) => h());
  return {
    isTauri: false,
    getSettings: async () => read(),
    setShortcut: async (shortcut) => write({ shortcut }),
    setNotificationsEnabled: async (notificationsEnabled) => write({ notificationsEnabled }),
    setActiveConnection: async (env) => {
      const s = read();
      const known = env ? [...s.known.filter((k) => k.envKey !== env.envKey), env] : s.known;
      const next = write({ active: env, known });
      emit('connection:changed');
      return next;
    },
    setToken: async (k, t) => storage.setItem(`cuenu.desktop.dev-token.${k}`, t),
    getToken: async (k) => storage.getItem(`cuenu.desktop.dev-token.${k}`),
    deleteToken: async (k) => storage.removeItem(`cuenu.desktop.dev-token.${k}`),
    hideQuick: async () => {},
    listen: async (event, handler) => {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    },
  };
}

let cached: Promise<NativeBridge> | null = null;
export function getBridge(): Promise<NativeBridge> {
  cached ??= isTauriRuntime() ? createTauriBridge() : Promise.resolve(createBrowserDevBridge());
  return cached;
}
