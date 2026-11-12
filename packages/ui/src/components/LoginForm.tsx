import { useState } from 'react';
import { usePlatform } from '../platform';

export function LoginForm({ onDone }: { onDone?(): void }) {
  const { auth } = usePlatform();
  const [serverUrl, setServerUrl] = useState(() => auth?.serverUrl?.() ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!auth) return null;
  return (
    <form
      className="cu-login"
      aria-label="ログイン"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!password) return;
        setBusy(true);
        setError(null);
        try {
          await auth.login({ password, serverUrl: auth.requiresServerUrl ? serverUrl.trim() : undefined });
          setPassword('');
          onDone?.();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {auth.requiresServerUrl && (
        <label className="cu-field">
          <span>サーバー URL</span>
          <input
            className="cu-input"
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="https://cuenu.example.workers.dev"
            required
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
          />
        </label>
      )}
      <label className="cu-field">
        <span>所有者パスワード</span>
        <input className="cu-input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && (
        <p className="cu-error" role="alert">
          ログインできませんでした: {error}
        </p>
      )}
      <button type="submit" className="cu-btn-primary" disabled={busy || !password}>
        {busy ? '接続中…' : 'ログイン'}
      </button>
      <p className="cu-meta-note">ログインしなくても、メモはこの端末に保存されます。</p>
    </form>
  );
}
