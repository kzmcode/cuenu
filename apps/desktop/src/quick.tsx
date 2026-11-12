// クイック入力ウィンドウ（label "quick"）。起動時に非表示で読み込まれて常駐する。
// - ⌘Enter: ローカル保存に成功したら隠す（失敗時は本文を保持して閉じない）
// - Esc: 下書きを保持して隠す
// 同期は通常ウィンドウ側が行う（同じ IndexedDB を共有）。

import '@cuenu/ui/styles.css';
import './desktop.css';
import { CuenuQuickInput } from '@cuenu/ui';
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { openLocalRepository, openRepository, type DesktopRepo } from './data';
import { getBridge, type NativeBridge } from './native';

function QuickWindow({ bridge, repo }: { bridge: NativeBridge; repo: DesktopRepo }) {
  const [focusSignal, setFocusSignal] = useState(0);
  const platform = useMemo(() => ({ repo, kind: 'mac' as const, captureScreen: bridge.captureScreen }), [repo, bridge]);

  useEffect(() => {
    const offs: Array<Promise<() => void>> = [
      bridge.listen('quick:shown', () => setFocusSignal((n) => n + 1)),
      // 赤ボタン等で閉じようとした場合も Esc と同じ扱い（下書きは Composer が保存済み）
      bridge.listen('quick:close-requested', () => void bridge.hideQuick()),
    ];
    return () => offs.forEach((p) => void p.then((off) => off()));
  }, [bridge]);

  return (
    <CuenuQuickInput
      platform={platform}
      draftKey="quick"
      focusSignal={focusSignal}
      onPosted={() => void bridge.hideQuick()}
      onDismiss={() => void bridge.hideQuick()}
    />
  );
}

async function start() {
  const bridge = await getBridge();
  const settings = await bridge.getSettings();
  // 未接続でも端末内（cuenu:local）へ保存できる。接続後に通常ウィンドウが接続先へ移す
  const repo = settings.active ? await openRepository(settings.active) : await openLocalRepository();
  await bridge.listen('connection:changed', () => window.location.reload());
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QuickWindow bridge={bridge} repo={repo} />
    </StrictMode>,
  );
}

void start();
