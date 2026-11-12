import { describe, expect, it, vi } from 'vitest';
import { acceleratorFromKeyEvent, formatAccelerator, formatHeldModifiers, normalizeAccelerator, saveShortcut } from './shortcut';

const key = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}, k = 'x') => ({
  code,
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('normalizeAccelerator', () => {
  it('エイリアスと順序を正規化する', () => {
    expect(normalizeAccelerator('option+ctrl+k')).toEqual({ ok: true, accelerator: 'Control+Alt+K' });
    expect(normalizeAccelerator('ctrl+cmd+m')).toEqual({ ok: true, accelerator: 'Control+Super+M' });
    expect(normalizeAccelerator('Cmd+Alt+Shift+m')).toEqual({ ok: true, accelerator: 'Alt+Shift+Super+M' });
    expect(normalizeAccelerator('Control+Alt+Digit1')).toEqual({ ok: true, accelerator: 'Control+Alt+1' });
    expect(normalizeAccelerator('Alt+ArrowUp')).toEqual({ ok: true, accelerator: 'Alt+Up' });
  });
  it('修飾キー不足・不明キー・予約済みを拒否する', () => {
    expect(normalizeAccelerator('Shift+A').ok).toBe(false);
    expect(normalizeAccelerator('A').ok).toBe(false);
    expect(normalizeAccelerator('Control+Alt').ok).toBe(false);
    expect(normalizeAccelerator('Hyper+A').ok).toBe(false);
    expect(normalizeAccelerator('Control+Alt+Foo').ok).toBe(false);
    expect(normalizeAccelerator('Cmd+Q')).toMatchObject({ ok: false });
    expect(normalizeAccelerator('Cmd+Space')).toMatchObject({ ok: false });
    // ⌘＋文字は登録できる（ユーザー指示）。⌘Q 等の予約済みだけ拒否
    expect(normalizeAccelerator('Cmd+M')).toEqual({ ok: true, accelerator: 'Super+M' });
    expect(normalizeAccelerator('Cmd+Shift+M')).toEqual({ ok: true, accelerator: 'Shift+Super+M' });
    // 入力ソース切替・絵文字と記号
    expect(normalizeAccelerator('Control+Alt+Space')).toMatchObject({ ok: false });
    expect(normalizeAccelerator('Control+Cmd+Space')).toMatchObject({ ok: false });
    expect(normalizeAccelerator('')).toMatchObject({ ok: false });
  });
});

describe('acceleratorFromKeyEvent', () => {
  it('修飾キーのみは入力待ち', () => {
    expect(acceleratorFromKeyEvent(key('AltLeft', { altKey: true }, 'Alt'))).toBeNull();
  });
  it('⌥で文字が変わっても物理キーで判定する', () => {
    expect(acceleratorFromKeyEvent(key('KeyM', { ctrlKey: true, altKey: true }, 'µ'))).toEqual({ ok: true, accelerator: 'Control+Alt+M' });
    expect(acceleratorFromKeyEvent(key('KeyM', { ctrlKey: true, metaKey: true }, 'm'))).toEqual({ ok: true, accelerator: 'Control+Super+M' });
  });
});

describe('formatHeldModifiers', () => {
  it('押している修飾キーを記号で返す', () => {
    expect(formatHeldModifiers({ ctrlKey: true, metaKey: true, altKey: false, shiftKey: false })).toBe('⌃⌘');
    expect(formatHeldModifiers({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe('');
  });
});

describe('formatAccelerator', () => {
  it('macOS の記号で表示する', () => {
    expect(formatAccelerator('Control+Alt+Space')).toBe('⌃⌥Space');
    expect(formatAccelerator('Shift+Super+Up')).toBe('⇧⌘↑');
  });
});

describe('saveShortcut', () => {
  it('正規化した値で登録・保存する', async () => {
    const setShortcut = vi.fn(async (shortcut: string) => ({ shortcut }) as never);
    const r = await saveShortcut({ setShortcut }, 'opt+ctrl+k');
    expect(setShortcut).toHaveBeenCalledWith('Control+Alt+K');
    expect(r.ok).toBe(true);
  });
  it('検証エラーなら Rust を呼ばない', async () => {
    const setShortcut = vi.fn();
    const r = await saveShortcut({ setShortcut }, 'Shift+K');
    expect(r.ok).toBe(false);
    expect(setShortcut).not.toHaveBeenCalled();
  });
  it('登録失敗（他アプリと衝突）をエラーとして返す', async () => {
    const setShortcut = vi.fn(async () => {
      throw 'ショートカットを登録できません';
    });
    expect(await saveShortcut({ setShortcut }, 'Control+Alt+K')).toEqual({ ok: false, error: 'ショートカットを登録できません' });
  });
});
