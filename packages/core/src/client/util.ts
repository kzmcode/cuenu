// クライアント共通の小物。

export type RepoErrorCode =
  | 'empty_body'
  | 'not_found'
  | 'deleted'
  | 'readonly'
  | 'cannot_undo'
  | 'invalid_bundle'
  | 'no_conflict'
  | 'no_summary'
  | 'closed';

/** リポジトリ操作の失敗（UI はメッセージ表示に code を使う） */
export class RepoError extends Error {
  readonly code: RepoErrorCode;
  constructor(code: RepoErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'RepoError';
    this.code = code;
  }
}

export const nowIso = (): string => new Date().toISOString();

export const uuid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

/** FNV-1a 32bit を 2 回（シード違い）で 64bit 相当の hex にする。DB名用で暗号用途ではない */
export function hashString(s: string): string {
  const h = (seed: number) => {
    let x = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      x ^= s.charCodeAt(i);
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    return x.toString(16).padStart(8, '0');
  };
  return h(0x811c9dc5) + h(0x050c5d1f);
}

/** サーバーURLを正規化（末尾スラッシュ除去・小文字ホスト） */
export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  try {
    const u = new URL(trimmed);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

/** 接続環境ごとの IndexedDB 名。未接続は cuenu:local */
export function dbNameFor(serverUrl: string | null | undefined): string {
  if (!serverUrl) return 'cuenu:local';
  return `cuenu:${hashString(normalizeServerUrl(serverUrl))}`;
}

/** 検索用正規化: NFKC + 小文字 + カタカナ→ひらがな */
export function normalizeText(s: string): string {
  const n = s.normalize('NFKC').toLowerCase();
  let out = '';
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    out += c >= 0x30a1 && c <= 0x30f6 ? String.fromCharCode(c - 0x60) : n[i];
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** 同一タブ内の直列化用ミューテックス */
export function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** Web Locks があればタブ/ウィンドウ横断で排他、無ければタブ内ミューテックス */
export function createCrossTabLock(name: string) {
  const local = createMutex();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    if (locks?.request) return locks.request(name, () => fn()) as Promise<T>;
    return local(fn);
  };
}
