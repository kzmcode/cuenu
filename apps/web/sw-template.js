/* Cuenu Service Worker（vite.config.ts の cuenuServiceWorker プラグインがビルド時に生成）。
 * - アプリシェルをキャッシュしてオフライン起動する。/api/* はキャッシュしない。
 * - IndexedDB（メモ・未送信キュー・下書き・一時画像）には一切触れない。更新で未送信データは消えない。
 * - 新しい版は待機し、ページからの SKIP_WAITING で切り替える。
 */
const VERSION = __CUENU_VERSION__;
const PRECACHE = __CUENU_PRECACHE__;
const CACHE = 'cuenu-shell-' + VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('cuenu-shell-') && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    // 入力欄をすぐ出すためキャッシュ済みシェルを優先（オフライン起動）。シェル更新は SW 更新で行う
    event.respondWith(
      caches.match('/', { cacheName: CACHE }).then((hit) => hit || fetch(req).catch(() => caches.match('/'))),
    );
    return;
  }
  event.respondWith(
    caches.match(req, { cacheName: CACHE }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          // SPA フォールバック（存在しない旧チャンクへの index.html）を assets として保存しない
          const type = res.headers.get('content-type') || '';
          if (res.ok && url.pathname.startsWith('/assets/') && !type.includes('text/html')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});

/** 通知クリックで開く URL は同一オリジンに限る（外部サイトへ誘導しない） */
function sameOriginUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  try {
    const parsed = new URL(u, self.location.origin);
    return parsed.origin === self.location.origin ? parsed.pathname + parsed.search + parsed.hash : null;
  } catch (e) {
    return null;
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const memoId = typeof data.memoId === 'string' && data.memoId ? data.memoId : null;
  const url = sameOriginUrl(data.url) || (memoId ? '/?memo=' + encodeURIComponent(memoId) : '/');
  event.waitUntil(
    self.registration.showNotification(data.title || 'Cuenu', {
      body: data.body || '新しいAIの提案があります',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: memoId ? 'memo-' + memoId : undefined,
      data: { url, memoId },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const url = d.url || '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          client.postMessage({ type: 'open-memo', memoId: d.memoId });
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
