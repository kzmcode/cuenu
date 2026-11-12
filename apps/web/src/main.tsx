import '@cuenu/ui/styles.css';
import './web.css';
import type { MemoRepository } from '@cuenu/core';
import { createIdbRepository, createMemoryRepository } from '@cuenu/core/client';
import { CuenuApp } from '@cuenu/ui';
import { StrictMode, useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { createWebHost, type WebHost } from './host';
import { registerServiceWorker, type SwUpdate } from './sw-register';

function takeInitialMemoId(): string | null {
  const url = new URL(location.href);
  const id = url.searchParams.get('memo');
  if (id) {
    url.searchParams.delete('memo');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  return id;
}

function Root({ host, storageWarning, versionChanged }: { host: WebHost; storageWarning: string | null; versionChanged: boolean }) {
  const platform = useSyncExternalStore(host.subscribe, host.getPlatform);
  const [initialMemoId] = useState(takeInitialMemoId);
  const [openRequest, setOpenRequest] = useState<{ memoId: string; at: number } | null>(null);
  const [update, setUpdate] = useState<SwUpdate | null>(null);

  useEffect(() => {
    if (import.meta.env.PROD) registerServiceWorker(setUpdate);
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'open-memo' && typeof e.data.memoId === 'string') setOpenRequest({ memoId: e.data.memoId, at: Date.now() });
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, []);

  return (
    <>
      {(storageWarning || versionChanged || update) && (
        <div className="web-banner" role="status">
          {storageWarning && <span>{storageWarning}</span>}
          {versionChanged && <span>別のタブで Cuenu が更新されました。再読み込みしてください。</span>}
          {update && !versionChanged && (
            <>
              <span>新しいバージョンがあります。</span>
              <button type="button" className="cu-btn-text" onClick={() => update.apply()}>
                更新する
              </button>
            </>
          )}
        </div>
      )}
      <CuenuApp platform={platform} initialMemoId={initialMemoId} openRequest={openRequest} />
    </>
  );
}

async function boot() {
  const root = createRoot(document.getElementById('root')!);
  let versionChanged = false;
  let repo: MemoRepository;
  let deviceId: string | null = null;
  let storageWarning: string | null = null;
  let persistent = true;
  try {
    // PWA は同一オリジンのサーバー固定。未ログインでも同じ DB に保存し、ログイン後にそのまま同期する
    const idb = await createIdbRepository({
      serverUrl: location.origin,
      onVersionChange: () => {
        versionChanged = true;
        render();
      },
    });
    repo = idb;
    deviceId = await idb.deviceId();
  } catch (e) {
    console.error(e);
    const mem = createMemoryRepository();
    repo = mem;
    persistent = false;
    storageWarning = 'この環境では端末内に保存できません（プライベートブラウズ等）。閉じるとメモが失われます。';
  }
  const host = createWebHost(repo, deviceId, persistent);
  const render = () =>
    root.render(
      <StrictMode>
        <Root host={host} storageWarning={storageWarning} versionChanged={versionChanged} />
      </StrictMode>,
    );
  render();
}

void boot();
