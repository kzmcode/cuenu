// 設定画面に差し込む Mac 固有項目: クイック入力のショートカット、接続先。
// Mac 通知の有効/無効は @cuenu/ui の通知セクション（NotificationAdapter = platform.ts）で扱う。

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { acceleratorFromKeyEvent, formatAccelerator, formatHeldModifiers, saveShortcut } from './shortcut';
import type { DesktopSettings, NativeBridge } from './native';

export interface MacSettingsProps {
  bridge: NativeBridge;
  settings: DesktopSettings;
  onSettings(s: DesktopSettings): void;
  onChangeConnection(): void;
}

export function MacSettings({ bridge, settings, onSettings, onChangeConnection }: MacSettingsProps) {
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState('');
  const [error, setError] = useState<string | null>(settings.shortcutError);
  const [notice, setNotice] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => setError(settings.shortcutError), [settings.shortcutError]);

  // 記録中はいまのショートカットを外す（押すとクイック入力が開いてしまうため）。終わったら戻す
  useEffect(() => {
    if (!recording) return;
    void bridge.pauseShortcut?.();
    boxRef.current?.focus();
    return () => void bridge.resumeShortcut?.();
  }, [recording, bridge]);

  const stop = () => {
    setRecording(false);
    setHeld('');
  };

  const apply = async (accel: string) => {
    const r = await saveShortcut(bridge, accel);
    if (r.ok) {
      onSettings(r.settings);
      setError(null);
      setNotice(`${formatAccelerator(r.settings.shortcut)} を設定しました`);
    } else {
      setError(r.error);
    }
    stop();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      stop();
      return;
    }
    setHeld(formatHeldModifiers(e));
    const r = acceleratorFromKeyEvent(e);
    if (!r) return; // 修飾キーだけ押している間は待つ
    if (r.ok) {
      void apply(r.accelerator);
    } else {
      setError(r.error);
    }
  };

  return (
    <>
      <div className="cu-settings-section">
        <h3>Mac: クイック入力</h3>
        <p className="cu-meta-note">どのアプリを使っていても、このキーでクイック入力を開きます。</p>
        <div className="cu-shortcut-row">
          {recording ? (
            <div
              ref={boxRef}
              className="cu-shortcut-recorder"
              role="textbox"
              tabIndex={0}
              aria-label="新しいショートカットのキーを押してください"
              onKeyDown={onKeyDown}
              onKeyUp={(e) => setHeld(formatHeldModifiers(e))}
              onBlur={stop}
            >
              {held ? <kbd className="cu-kbd cu-kbd--live">{held}…</kbd> : <span>キーを押してください</span>}
            </div>
          ) : (
            <button
              type="button"
              className="cu-shortcut-current"
              aria-label={`ショートカット ${formatAccelerator(settings.shortcut)}。クリックして変更`}
              onClick={() => {
                setError(null);
                setNotice(null);
                setRecording(true);
              }}
            >
              <kbd className="cu-kbd">{formatAccelerator(settings.shortcut)}</kbd>
              <span className="cu-shortcut-edit">変更</span>
            </button>
          )}
          {!recording && settings.shortcut !== settings.defaultShortcut && (
            <button type="button" className="cu-btn-text" onClick={() => void apply(settings.defaultShortcut)}>
              初期値（{formatAccelerator(settings.defaultShortcut)}）に戻す
            </button>
          )}
          {recording && (
            <button type="button" className="cu-btn-text" onMouseDown={(e) => e.preventDefault()} onClick={stop}>
              キャンセル
            </button>
          )}
        </div>
        {recording && <p className="cu-meta-note">⌃・⌥・⌘ のいずれかと、文字・数字・Space などを同時に押します（Esc で中止）。</p>}
        {!recording && !settings.shortcutRegistered && !error && <p className="cu-error">ショートカットが登録されていません。別のキーを設定してください。</p>}
        {error && <p className="cu-error" role="alert">{error}</p>}
        {notice && <p role="status" className="cu-meta-note">{notice}</p>}
      </div>

      <div className="cu-settings-section">
        <h3>Mac: 接続先</h3>
        <dl className="cu-dl">
          <dt>サーバー</dt>
          <dd>{settings.active?.serverUrl ?? '未設定'}</dd>
        </dl>
        <button type="button" className="cu-btn" onClick={onChangeConnection}>
          接続先を変更・再ログイン
        </button>
        <p className="cu-meta-note">
          接続先ごとに端末内のデータを分けて保存します。切り替えても前の接続先のメモと未送信の変更は削除されず、前の接続先に戻すと再送されます。
        </p>
      </div>
    </>
  );
}
