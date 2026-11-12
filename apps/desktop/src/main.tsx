// 通常ウィンドウ（label "main"）。閉じても Rust 側で隠すだけなので、この JS は常駐し同期・通知を担う。

import '@cuenu/ui/styles.css';
import './desktop.css';
import { CuenuApp } from '@cuenu/ui';
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadActiveConnection, type ActiveConnection } from './connection';
import { adoptLocalMemos, createSync, openRepository, type DesktopRepo, type DesktopSync } from './data';
import { MacSettings } from './MacSettings';
import { getBridge, type DesktopSettings, type NativeBridge } from './native';
import { createSeenStore, startAiNotifier, tauriNotify } from './notifier';
import { createMacPlatform, readNotificationPermission } from './platform';
import { SetupScreen } from './SetupScreen';

interface Boot {
  bridge: NativeBridge;
  settings: DesktopSettings;
  active: ActiveConnection;
  repo: DesktopRepo | null;
  sync: DesktopSync | null;
  permission: Awaited<ReturnType<typeof readNotificationPermission>>;
}

async function boot(): Promise<Boot> {
  const bridge = await getBridge();
  const settings = await bridge.getSettings();
  const active = await loadActiveConnection(bridge);
  const repo = active.state === 'none' ? null : await openRepository(active.env);
  // 接続前にクイック入力で書いたメモを、この接続先へ未送信として移す
  if (repo) await adoptLocalMemos(repo).catch((e) => console.error('adoptLocalMemos', e));
  let sync: DesktopSync | null = null;
  if (repo && active.state === 'ready') {
    sync = createSync(repo, active.config);
    sync.start();
  }
  return { bridge, settings, active, repo, sync, permission: await readNotificationPermission(bridge.isTauri) };
}

function MainWindow({ boot: b }: { boot: Boot }) {
  const [settings, setSettings] = useState(b.settings);
  const [setupOpen, setSetupOpen] = useState(b.active.state === 'none');
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const platform = useMemo(
    () =>
      b.repo
        ? createMacPlatform(
            { bridge: b.bridge, repo: b.repo, sync: b.sync, active: b.active, settings: () => settingsRef.current, onSettings: setSettings },
            b.permission,
          )
        : null,
    [b],
  );

  // AI 新着の Mac 通知（同期で受け取った author='ai' のトップレベル投稿）
  useEffect(() => {
    if (!b.repo || b.active.state === 'none' || !b.bridge.isTauri) return;
    const repo = b.repo;
    return startAiNotifier({
      repo,
      syncStatus: () => b.sync?.status() ?? repo.syncStatus(),
      isEnabled: () => settingsRef.current.notificationsEnabled,
      notify: tauriNotify,
      seen: createSeenStore(b.active.env.envKey, localStorage),
    });
  }, [b]);

  if (setupOpen || !platform) {
    return (
      <SetupScreen
        bridge={b.bridge}
        current={settings.active}
        pendingOps={b.repo?.syncStatus().pendingOps ?? 0}
        onConnected={() => window.location.reload()}
        onCancel={platform ? () => setSetupOpen(false) : undefined}
      />
    );
  }

  return (
    <>
      <CuenuApp
        platform={platform}
        notice={
          b.active.state === 'needs-login' ? (
            <div className="cu-desktop-banner" role="status">
              <span>ログインが必要です（メモはこの Mac に保存され、ログイン後に同期されます）。</span>
              <button type="button" className="cu-btn" onClick={() => setSetupOpen(true)}>
                ログイン
              </button>
            </div>
          ) : null
        }
        settingsExtra={<MacSettings bridge={b.bridge} settings={settings} onSettings={setSettings} onChangeConnection={() => setSetupOpen(true)} />}
      />
    </>
  );
}

async function start() {
  const root = createRoot(document.getElementById('root')!);
  try {
    const b = await boot();
    // 接続先が変わったら DB・同期を作り直すため再読み込み（クイック入力側も同様）
    await b.bridge.listen('connection:changed', () => window.location.reload());
    root.render(
      <StrictMode>
        <MainWindow boot={b} />
      </StrictMode>,
    );
  } catch (e) {
    root.render(
      <main className="cu-desktop-setup">
        <h1>起動できませんでした</h1>
        <p className="cu-error">{e instanceof Error ? e.message : String(e)}</p>
        <p className="cu-meta-note">docs/desktop.md の「困ったとき」を参照してください。端末内のデータは削除されていません。</p>
      </main>,
    );
  }
}

void start();
