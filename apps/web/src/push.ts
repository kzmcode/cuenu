// Web Push 購読（通知を有効にするボタンから呼ぶ）。
import type { ApiClient } from '@cuenu/core/client';
import type { NotificationAdapter, NotificationPermissionState } from '@cuenu/ui';

function base64UrlToUint8Array(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

export function createPushAdapter(getApi: () => ApiClient | null, getDeviceId: () => string | null): NotificationAdapter {
  const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const registration = async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) throw new Error('Service Worker が未登録です（本番ビルドで利用できます）');
    return reg;
  };
  return {
    permission(): NotificationPermissionState {
      return supported() ? (Notification.permission as NotificationPermissionState) : 'unsupported';
    },
    unsupportedReason() {
      if (isIos() && !isStandalone()) return 'iPhone / iPad では、共有メニューの「ホーム画面に追加」から開いた Cuenu で通知を有効にできます。';
      if (!supported()) return 'このブラウザは Web Push 通知に対応していません。';
      return null;
    },
    async isEnabled() {
      if (!supported()) return false;
      const reg = await navigator.serviceWorker.getRegistration();
      return !!(await reg?.pushManager.getSubscription());
    },
    async enable() {
      const api = getApi();
      const deviceId = getDeviceId();
      if (!api || !deviceId) throw new Error('ログインが必要です');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('通知が許可されませんでした');
      const reg = await registration();
      const { publicKey } = await api.vapidPublicKey();
      const key = base64UrlToUint8Array(publicKey);
      let sub = await reg.pushManager.getSubscription();
      // サーバーの VAPID 鍵が変わっていたら古い購読では届かないので作り直す
      if (sub && !sameKey(sub.options.applicationServerKey, key)) {
        await sub.unsubscribe();
        sub = null;
      }
      const created = !sub;
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      try {
        await api.subscribePush(deviceId, sub.toJSON());
      } catch (e) {
        // サーバーに登録できなければ端末側も戻す（「有効」と表示されたまま届かない状態にしない）
        if (created) await sub.unsubscribe().catch(() => {});
        throw e;
      }
    },
    async disable() {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (!sub) return;
      await getApi()?.unsubscribePush(sub.endpoint).catch(() => {});
      await sub.unsubscribe();
    },
  };
}
