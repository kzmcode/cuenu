// 端末トークンの保存とログイン状態（PWA は同一オリジンの /api）。
import { createApiClient, login as apiLogin } from '@cuenu/core/client';

const KEY = 'cuenu.session';

export interface Session {
  token: string;
  deviceId: string;
}

export function loadSession(): Session | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Session | null;
    return v && typeof v.token === 'string' && typeof v.deviceId === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone PWA';
  if (/iPad/.test(ua)) return 'iPad PWA';
  if (/Android/.test(ua)) return 'Android PWA';
  return 'Web';
}

export async function loginWithPassword(password: string, previousDeviceId?: string): Promise<Session> {
  const res = await apiLogin('', { password, deviceName: deviceName(), deviceId: previousDeviceId });
  return { token: res.token, deviceId: res.deviceId };
}

export async function logoutRemote(s: Session): Promise<void> {
  await createApiClient('', s.token).logout();
}
