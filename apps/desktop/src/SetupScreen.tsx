// 初回起動・接続先変更の画面: サーバーURL → 接続確認 → 所有者パスワードでログイン → Keychain 保存。

import { useState } from 'react';
import { connect, normalizeServerUrl, planSwitch, type ConnectStep } from './connection';
import type { EnvConfig, NativeBridge } from './native';

const STEP_LABEL: Record<ConnectStep, string> = {
  validating: '入力を確認しています…',
  health: 'サーバーに接続し、互換性を確認しています…',
  login: 'ログインしています…',
  saving: 'Keychain に保存しています…',
};

export interface SetupScreenProps {
  bridge: NativeBridge;
  current: EnvConfig | null;
  /** 現在の環境の未送信件数（接続先変更時の確認に使う） */
  pendingOps?: number;
  initialUrl?: string;
  onConnected(env: EnvConfig): void;
  onCancel?(): void;
}

export function SetupScreen({ bridge, current, pendingOps = 0, initialUrl, onConnected, onCancel }: SetupScreenProps) {
  const [url, setUrl] = useState(initialUrl ?? current?.serverUrl ?? '');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<ConnectStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);

  const run = async (confirmed: boolean) => {
    setError(null);
    const u = normalizeServerUrl(url);
    if (u.ok && !confirmed) {
      const plan = planSwitch(current, u.origin, pendingOps);
      if (plan.kind === 'switch' && plan.message) {
        setConfirmMsg(plan.message);
        return;
      }
    }
    setConfirmMsg(null);
    const r = await connect(url, password, { fetch: (i, init) => fetch(i, init), bridge, onStep: setStep });
    setStep(null);
    if (r.ok) {
      setPassword('');
      onConnected(r.env);
    } else {
      setError(r.message);
    }
  };

  return (
    <main className="cu-desktop-setup">
      <h1>{current ? '接続先・ログイン' : 'Cuenu へようこそ'}</h1>
      {!current && (
        <p className="cu-meta-note">
          自分でデプロイした Cuenu サーバーの URL と、サーバーに設定した所有者パスワード（OWNER_PASSWORD）を入力してください。
          ログイン情報はこの Mac の Keychain に保存されます。
        </p>
      )}
      <form
        className="cu-login"
        onSubmit={(e) => {
          e.preventDefault();
          void run(false);
        }}
      >
        <label className="cu-field">
          <span>サーバー URL</span>
          <input
            className="cu-input"
            type="text"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder="https://cuenu.YOUR_SUBDOMAIN.workers.dev"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
        </label>
        <label className="cu-field">
          <span>所有者パスワード</span>
          <input className="cu-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {step && <p role="status">{STEP_LABEL[step]}</p>}
        {error && (
          <p className="cu-error" role="alert">
            {error}
          </p>
        )}
        {confirmMsg ? (
          <div className="cu-desktop-confirm" role="alertdialog" aria-label="接続先変更の確認">
            <p>{confirmMsg}</p>
            <button type="button" className="cu-btn-primary" onClick={() => void run(true)}>
              理解して切り替える
            </button>
            <button type="button" className="cu-btn" onClick={() => setConfirmMsg(null)}>
              やめる
            </button>
          </div>
        ) : (
          <div className="cu-desktop-actions">
            <button type="submit" className="cu-btn-primary" disabled={!!step || !url || !password}>
              接続してログイン
            </button>
            {onCancel && (
              <button type="button" className="cu-btn" onClick={onCancel}>
                キャンセル
              </button>
            )}
          </div>
        )}
      </form>
    </main>
  );
}
