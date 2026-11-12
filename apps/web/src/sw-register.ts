// Service Worker 登録と更新通知。新しい版は利用者の操作で切り替える（入力中に勝手に再読み込みしない）。
export interface SwUpdate {
  apply(): void;
}

export function registerServiceWorker(onUpdate: (u: SwUpdate) => void): void {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloading) return;
    window.location.reload();
  });
  const offer = (w: ServiceWorker) =>
    onUpdate({
      apply() {
        reloading = true;
        // 下書きは入力のたびに IndexedDB へ退避済み。pagehide でも退避する
        w.postMessage({ type: 'SKIP_WAITING' });
      },
    });
  navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
        });
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reg.update().catch(() => {});
      });
    })
    .catch((e) => console.warn('Service Worker 登録失敗', e));
}
