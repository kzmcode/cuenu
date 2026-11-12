// @cuenu/ui（担当C）へ渡す CuenuPlatform の Mac 実装。

import { connect, envKeyFor, logout, normalizeServerUrl, planSwitch, type ActiveConnection } from './connection';
import type { DesktopRepo, DesktopSync } from './data';
import type { DesktopSettings, NativeBridge } from './native';

// @cuenu/ui の型（AuthAdapter 等）は構造的に満たす。ui 側の型名変更に引きずられないよう最小限だけ宣言。
type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

export interface MacPlatformDeps {
  bridge: NativeBridge;
  repo: DesktopRepo;
  sync: DesktopSync | null;
  active: ActiveConnection;
  settings: () => DesktopSettings;
  onSettings: (s: DesktopSettings) => void;
}

export async function readNotificationPermission(isTauri: boolean): Promise<PermissionState> {
  if (!isTauri) return 'unsupported';
  try {
    const n = await import('@tauri-apps/plugin-notification');
    return (await n.isPermissionGranted()) ? 'granted' : 'default';
  } catch {
    return 'unsupported';
  }
}

export function createMacPlatform(deps: MacPlatformDeps, initialPermission: PermissionState) {
  const { bridge, repo, sync, active } = deps;
  const env = active.state === 'none' ? null : active.env;
  const token = active.state === 'ready' ? active.config.token : null;
  let permission = initialPermission;

  const auth = {
    requiresServerUrl: true,
    isLoggedIn: () => active.state === 'ready',
    serverUrl: () => env?.serverUrl ?? null,
    async login({ password, serverUrl }: { password: string; serverUrl?: string }) {
      const target = serverUrl || env?.serverUrl || '';
      const u = normalizeServerUrl(target);
      if (u.ok && env && envKeyFor(u.origin) !== env.envKey) {
        const plan = planSwitch(env, u.origin, repo.syncStatus().pendingOps);
        if (plan.kind === 'switch' && plan.message) {
          throw new Error(`${plan.message}（切り替えは「Mac: 接続先」の「接続先を変更・再ログイン」から確認のうえ行ってください）`);
        }
      }
      const r = await connect(target, password, { fetch: (i, init) => fetch(i, init), bridge });
      if (!r.ok) throw new Error(r.message);
      // connection:changed イベントで両ウィンドウが再読み込みされる
    },
    async logout() {
      if (!env) return;
      await logout(env, bridge, (i, init) => fetch(i, init));
      // 接続先・ローカルデータは残し、トークンだけ消す
      await bridge.setActiveConnection(env);
    },
  };

  // オンライン機能は同期コントローラの API クライアントを使う（トークン差し替えに追従）
  const api = sync && token ? sync.api : null;
  const server = api
    ? {
        semanticSearch: (query: string, limit?: number) => api.semanticSearch({ query, limit }),
        aiStatus: () => api.aiStatus(),
        getSettings: () => api.getSettings(),
        putSettings: (patch: Parameters<typeof api.putSettings>[0]) => api.putSettings(patch),
      }
    : null;

  const notifications = bridge.isTauri
    ? {
        permission: () => permission,
        isEnabled: async () => deps.settings().notificationsEnabled && permission === 'granted',
        async enable() {
          const n = await import('@tauri-apps/plugin-notification');
          if (!(await n.isPermissionGranted())) {
            const r = await n.requestPermission();
            permission = r === 'granted' ? 'granted' : r === 'denied' ? 'denied' : 'default';
          } else {
            permission = 'granted';
          }
          if (permission !== 'granted') throw new Error('通知が許可されていません。macOS のシステム設定 → 通知 → Cuenu で許可してください。');
          deps.onSettings(await bridge.setNotificationsEnabled(true));
        },
        async disable() {
          deps.onSettings(await bridge.setNotificationsEnabled(false));
        },
        unsupportedReason: () => null,
      }
    : null;

  return {
    repo,
    sync,
    auth,
    server,
    notifications,
    deviceId: env?.deviceId ?? null,
    kind: 'mac' as const,
    captureScreen: bridge.captureScreen,
  };
}
