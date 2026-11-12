// グローバルショートカットの入力・検証・表示・保存。
// 保存形式は Rust の global-hotkey が解釈できる "Modifier+...+Key"（例 "Control+Alt+Space"）。

import type { DesktopSettings, NativeBridge } from './native';

export type Modifier = 'Super' | 'Control' | 'Alt' | 'Shift';
const MODIFIER_ORDER: Modifier[] = ['Control', 'Alt', 'Shift', 'Super'];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  super: 'Super',
  cmd: 'Super',
  command: 'Super',
  meta: 'Super',
  commandorcontrol: 'Super', // macOS 専用アプリのため Command に寄せる
  cmdorctrl: 'Super',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift',
};

const NAMED_KEYS = new Set([
  'Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'Up', 'Down', 'Left', 'Right', 'Backquote', 'Backslash', 'BracketLeft', 'BracketRight',
  'Comma', 'Period', 'Slash', 'Semicolon', 'Quote', 'Minus', 'Equal',
]);

/** macOS 標準操作と衝突し、登録すると困るもの */
const RESERVED: Record<string, string> = {
  'Super+Q': 'アプリの終了（⌘Q）と衝突します',
  'Super+W': 'ウィンドウを閉じる（⌘W）と衝突します',
  'Super+Tab': 'アプリ切替（⌘Tab）と衝突します',
  'Super+Space': 'Spotlight（⌘Space）と衝突します',
  'Control+Space': '入力ソース切替（⌃Space）と衝突する場合があります',
  'Control+Alt+Space': '入力ソース切替（⌃⌥Space）と衝突する場合があります',
  'Control+Super+Space': '絵文字と記号（⌃⌘Space）と衝突します',
  'Control+Super+Q': '画面のロック（⌃⌘Q）と衝突します',
  'Control+Super+F': 'フルスクリーン（⌃⌘F）と衝突します',
};

export type ShortcutCheck = { ok: true; accelerator: string } | { ok: false; error: string };

function normalizeKey(raw: string): string | null {
  const k = raw.trim();
  if (/^[a-z]$/i.test(k)) return k.toUpperCase();
  if (/^Key[A-Z]$/.test(k)) return k.slice(3);
  if (/^[0-9]$/.test(k)) return k;
  if (/^Digit[0-9]$/.test(k)) return k.slice(5);
  if (/^F([1-9]|1[0-9]|20)$/i.test(k)) return k.toUpperCase();
  const arrow = /^Arrow(Up|Down|Left|Right)$/.exec(k);
  if (arrow) return arrow[1]!;
  const named = [...NAMED_KEYS].find((n) => n.toLowerCase() === k.toLowerCase());
  return named ?? null;
}

/** 文字列を正規化して検証する（設定ファイル・手入力用） */
export function normalizeAccelerator(input: string): ShortcutCheck {
  const parts = input.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { ok: false, error: 'ショートカットが空です' };
  const keyRaw = parts[parts.length - 1]!;
  const mods = new Set<Modifier>();
  for (const p of parts.slice(0, -1)) {
    const m = MODIFIER_ALIASES[p.toLowerCase()];
    if (!m) return { ok: false, error: `不明な修飾キー: ${p}` };
    mods.add(m);
  }
  if (MODIFIER_ALIASES[keyRaw.toLowerCase()]) return { ok: false, error: '修飾キー以外のキーを1つ含めてください' };
  const key = normalizeKey(keyRaw);
  if (!key) return { ok: false, error: `使用できないキー: ${keyRaw}` };
  if (!mods.has('Super') && !mods.has('Control') && !mods.has('Alt')) {
    return { ok: false, error: '⌘・⌃・⌥ のいずれかを含めてください（通常の文字入力と衝突するため）' };
  }
  const accelerator = [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+');
  const reserved = RESERVED[accelerator];
  if (reserved) return { ok: false, error: reserved };
  return { ok: true, accelerator };
}

export interface KeyLike {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * keydown から候補を作る。修飾キーだけが押されている間は null（入力待ち）。
 * ⌥ で e.key が別文字になるため、物理キーの e.code を使う。
 */
export function acceleratorFromKeyEvent(e: KeyLike): ShortcutCheck | null {
  if (['Meta', 'Control', 'Alt', 'Shift', 'OS'].includes(e.key) || /^(Meta|Control|Alt|Shift|OS)(Left|Right)$/.test(e.code)) {
    return null;
  }
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  return normalizeAccelerator([...mods, e.code || e.key].join('+'));
}

const SYMBOLS: Record<string, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘' };
const KEY_LABELS: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→', Enter: '↩', Backspace: '⌫', Tab: '⇥' };

/** 押している最中の修飾キーの表示（例 "⌃⌘"）。記録中の表示用 */
export function formatHeldModifiers(e: Pick<KeyLike, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string {
  return (e.ctrlKey ? '⌃' : '') + (e.altKey ? '⌥' : '') + (e.shiftKey ? '⇧' : '') + (e.metaKey ? '⌘' : '');
}

/** "Control+Alt+Space" → "⌃⌥Space" */
export function formatAccelerator(accelerator: string): string {
  const parts = accelerator.split('+');
  const key = parts.pop() ?? '';
  return parts.map((p) => SYMBOLS[p] ?? p).join('') + (KEY_LABELS[key] ?? key);
}

export type SaveShortcutResult = { ok: true; settings: DesktopSettings } | { ok: false; error: string };

/** 検証 → Rust で登録（成功時のみ保存・旧ショートカット解除） */
export async function saveShortcut(bridge: Pick<NativeBridge, 'setShortcut'>, input: string): Promise<SaveShortcutResult> {
  const check = normalizeAccelerator(input);
  if (!check.ok) return check;
  try {
    return { ok: true, settings: await bridge.setShortcut(check.accelerator) };
  } catch (e) {
    return { ok: false, error: typeof e === 'string' ? e : e instanceof Error ? e.message : String(e) };
  }
}
