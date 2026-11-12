import { DEFAULT_SETTINGS, type AiStatusResponse, type ExportBundle, type ThemePreference, type UserSettings } from '@cuenu/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePrefs } from '../context';
import { formatFullDate } from '../format';
import { useLoggedIn, useOnline, useSyncStatus } from '../hooks';
import { usePlatform, type NotificationPermissionState } from '../platform';
import { useTheme } from '../theme/ThemeProvider';
import { LoginForm } from './LoginForm';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'システムに合わせる' },
  { value: 'light', label: 'ライト' },
  { value: 'dark', label: 'ダーク' },
];

export interface SettingsProps {
  extra?: ReactNode;
  /** サーバー設定の取得・保存時に呼ぶ（タイムゾーン表示の更新用） */
  onSettingsLoaded?(s: UserSettings): void;
}

export function Settings({ extra, onSettingsLoaded }: SettingsProps) {
  return (
    <section className="cu-settings" aria-label="設定">
      <h2 className="cu-view-title">設定</h2>
      <ConnectionSection />
      <ThemeSection />
      <NotificationSection />
      <ServerSettingsSection onLoaded={onSettingsLoaded} />
      <DataSection />
      {extra}
    </section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="cu-settings-section">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function ConnectionSection() {
  const { auth, sync } = usePlatform();
  const status = useSyncStatus();
  const online = useOnline();
  const loggedIn = useLoggedIn();
  const { timezone } = usePrefs();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const doLogout = async () => {
    setConfirmLogout(false);
    try {
      await auth?.logout();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Section title="接続・同期">
      <dl className="cu-dl">
        <dt>通信</dt>
        <dd>{online ? 'オンライン' : 'オフライン'}</dd>
        {auth && (
          <>
            <dt>サーバー</dt>
            <dd>{loggedIn ? `ログイン中${auth.serverUrl?.() ? `（${auth.serverUrl()}）` : ''}` : '未ログイン（端末内のみに保存）'}</dd>
          </>
        )}
        {status && (
          <>
            <dt>同期</dt>
            <dd>{status.syncing ? '同期中…' : status.lastError ? `⚠ 失敗: ${status.lastError}` : status.configured ? '待機中' : '未設定'}</dd>
            <dt>未送信</dt>
            <dd>{status.pendingOps} 件</dd>
            <dt>競合</dt>
            <dd>{status.conflicts} 件{status.conflicts > 0 ? '（タイムラインの「競合あり」から選択）' : ''}</dd>
            <dt>最終同期</dt>
            <dd>{status.lastSyncedAt ? formatFullDate(status.lastSyncedAt, timezone) : 'まだありません'}</dd>
            <dt>初回取り込み</dt>
            <dd>{status.initialImportDone ? '完了（サーバーの記録はすべてこの端末にあります）' : '未完了（一部の記録はまだこの端末にありません）'}</dd>
          </>
        )}
      </dl>
      {sync && loggedIn && (
        <button
          type="button"
          className="cu-btn"
          disabled={busy || !online}
          onClick={async () => {
            setBusy(true);
            setMsg(null);
            try {
              await sync.syncNow();
            } catch (e) {
              setMsg(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          今すぐ同期
        </button>
      )}
      {msg && <p className="cu-error">{msg}</p>}
      {auth &&
        (loggedIn ? (
          confirmLogout ? (
            <div className="cu-confirm" role="alertdialog" aria-label="ログアウトの確認">
              <p>
                未送信の変更が {status?.pendingOps ?? 0} 件あります。ログアウトしても端末内のメモは消えませんが、再ログインするまで送信されません。
              </p>
              <div className="cu-row">
                <button type="button" className="cu-btn-danger" onClick={() => void doLogout()}>
                  ログアウトする
                </button>
                <button type="button" className="cu-btn" onClick={() => setConfirmLogout(false)}>
                  キャンセル
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="cu-btn"
              onClick={() => ((status?.pendingOps ?? 0) > 0 ? setConfirmLogout(true) : void doLogout())}
            >
              ログアウト
            </button>
          )
        ) : (
          <LoginForm />
        ))}
    </Section>
  );
}

function ThemeSection() {
  const { preference, setPreference } = useTheme();
  return (
    <Section title="テーマ">
      <div role="radiogroup" aria-label="テーマ" className="cu-radio-group">
        {THEME_OPTIONS.map((o) => (
          <label key={o.value} className="cu-radio">
            <input type="radio" name="cu-theme" value={o.value} checked={preference === o.value} onChange={() => setPreference(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </Section>
  );
}

const PERMISSION_LABEL: Record<NotificationPermissionState, string> = {
  default: '未設定',
  granted: '許可済み',
  denied: '拒否されています（ブラウザ/OS の設定から許可してください）',
  unsupported: 'この環境では使えません',
};

function NotificationSection() {
  const { notifications } = usePlatform();
  const loggedIn = useLoggedIn();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [perm, setPerm] = useState<NotificationPermissionState>(() => notifications?.permission() ?? 'unsupported');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    notifications
      ?.isEnabled()
      .then((v) => alive && setEnabled(v))
      .catch(() => alive && setEnabled(false));
    return () => {
      alive = false;
    };
  }, [notifications]);
  if (!notifications) return null;
  const reason = notifications.unsupportedReason?.() ?? null;
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEnabled(await notifications.isEnabled());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPerm(notifications.permission());
      setBusy(false);
    }
  };
  return (
    <Section title="通知">
      <p className="cu-meta-note">AI の新しい投稿を通知します。通知本文にメモの内容は表示しません（既定）。</p>
      <dl className="cu-dl">
        <dt>権限</dt>
        <dd>{PERMISSION_LABEL[perm]}</dd>
        <dt>この端末</dt>
        <dd>{enabled === null ? '確認中…' : enabled ? '有効' : '無効'}</dd>
      </dl>
      {reason && <p className="cu-notice">{reason}</p>}
      {!reason && perm !== 'unsupported' && (
        enabled ? (
          <button type="button" className="cu-btn" disabled={busy} onClick={() => void act(() => notifications.disable())}>
            通知を無効にする
          </button>
        ) : (
          <button type="button" className="cu-btn-primary" disabled={busy || perm === 'denied' || !loggedIn} onClick={() => void act(() => notifications.enable())}>
            通知を有効にする
          </button>
        )
      )}
      {!loggedIn && !reason && <p className="cu-meta-note">通知を有効にするにはログインが必要です。</p>}
      {error && (
        <p className="cu-error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}

function timezones(): string[] {
  const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  try {
    return fn ? fn('timeZone') : ['Asia/Tokyo', 'UTC'];
  } catch {
    return ['Asia/Tokyo', 'UTC'];
  }
}

function ServerSettingsSection({ onLoaded }: { onLoaded?(s: UserSettings): void }) {
  const { server, auth } = usePlatform();
  const online = useOnline();
  const loggedIn = useLoggedIn();
  const { timezone } = usePrefs();
  const [ai, setAi] = useState<AiStatusResponse | null>(null);
  const [form, setForm] = useState<UserSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const usable = !!server && (!auth || loggedIn) && online;
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  useEffect(() => {
    if (!usable || !server) return;
    let alive = true;
    Promise.all([server.aiStatus(), server.getSettings()])
      .then(([a, s]) => {
        if (!alive) return;
        setAi(a);
        setForm(s);
        onLoadedRef.current?.(s);
        setError(null);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [usable, server]);

  if (!server) return null;
  return (
    <Section title="AI・表示">
      {!usable && <p className="cu-notice">{online ? 'ログインすると AI の状態と設定を表示できます。' : 'オフラインのため AI の状態を取得できません。'}</p>}
      {ai && (
        <dl className="cu-dl">
          <dt>AI</dt>
          <dd>{!ai.configured ? '未設定（サーバーに API キーがありません）' : ai.enabled ? '有効' : '無効'}</dd>
          <dt>今日の投稿</dt>
          <dd>
            {ai.postsToday} / {ai.dailyLimit} 件
          </dd>
          <dt>最終実行</dt>
          <dd>{ai.lastRunAt ? formatFullDate(ai.lastRunAt, timezone) : 'まだありません'}</dd>
          <dt>処理待ち</dt>
          <dd>{ai.pendingJobs} 件</dd>
          {ai.pausedUntil && (
            <>
              <dt>待機中</dt>
              <dd>{formatFullDate(ai.pausedUntil, timezone)} まで（利用制限）</dd>
            </>
          )}
          {ai.lastError && (
            <>
              <dt>直近のエラー</dt>
              <dd>⚠ {ai.lastError}</dd>
            </>
          )}
        </dl>
      )}
      {form && (
        <form
          className="cu-settings-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setSaved(false);
            setError(null);
            try {
              const s = await server.putSettings(form);
              setForm(s);
              onLoadedRef.current?.(s);
              setSaved(true);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="cu-field">
            <span>タイムゾーン</span>
            <select className="cu-input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {Array.from(new Set([form.timezone, ...timezones()])).map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>
          <label className="cu-field">
            <span>AI 投稿の 1 日の上限（件）</span>
            <input
              className="cu-input"
              type="number"
              min={0}
              max={20}
              value={form.dailyAiPostLimit}
              onChange={(e) => setForm({ ...form, dailyAiPostLimit: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
            />
          </label>
          <label className="cu-check">
            <input type="checkbox" checked={form.aiEnabled} onChange={(e) => setForm({ ...form, aiEnabled: e.target.checked })} />
            <span>AI の整理・提案を有効にする</span>
          </label>
          <label className="cu-check">
            <input type="checkbox" checked={form.notificationDetail} onChange={(e) => setForm({ ...form, notificationDetail: e.target.checked })} />
            <span>通知に投稿内容を表示する（ロック画面に表示される場合があります）</span>
          </label>
          <div className="cu-row">
            <button type="submit" className="cu-btn-primary" disabled={busy}>
              保存
            </button>
            <button type="button" className="cu-btn" onClick={() => setForm({ ...DEFAULT_SETTINGS })}>
              既定値に戻す
            </button>
          </div>
          {saved && <p role="status">保存しました</p>}
        </form>
      )}
      {error && (
        <p className="cu-error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}

function downloadJson(fileName: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isExportBundle(v: unknown): v is ExportBundle {
  const b = v as ExportBundle;
  return !!b && b.app === 'cuenu' && b.format === 1 && Array.isArray(b.memos);
}

function DataSection() {
  const { repo, files } = usePlatform();
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <Section title="データ">
      <p className="cu-meta-note">エクスポートは端末内のすべてのメモ・返信を JSON で保存します（画像は含みません）。</p>
      <div className="cu-row">
        <button
          type="button"
          className="cu-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const bundle = await repo.exportAll();
              const name = `cuenu-export-${bundle.exportedAt.slice(0, 10)}.json`;
              if (files) await files.saveJson(name, bundle);
              else downloadJson(name, bundle);
              setMsg(`${bundle.memos.length} 件をエクスポートしました`);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          エクスポート
        </button>
        <button type="button" className="cu-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
          インポート
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          data-testid="import-file"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setBusy(true);
            setError(null);
            setMsg(null);
            try {
              const data: unknown = JSON.parse(await f.text());
              if (!isExportBundle(data)) throw new Error('Cuenu のエクスポートファイルではありません');
              const { imported } = await repo.importBundle(data);
              setMsg(`${imported} 件を取り込みました`);
            } catch (err) {
              setError(`インポートできませんでした: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>
      {msg && <p role="status">{msg}</p>}
      {error && (
        <p className="cu-error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}
