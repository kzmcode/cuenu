import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getThemeInitScript, resolveTheme, THEME_STORAGE_KEY } from '../src/theme/script';
import { contrastRatio, cssVarName, DARK_TOKENS, LIGHT_TOKENS, type ThemeTokens } from '../src/theme/tokens';

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

function cssBlock(selector: string): Record<string, string> {
  const i = css.indexOf(selector + ' {');
  const body = css.slice(i, css.indexOf('}', i));
  return Object.fromEntries([...body.matchAll(/(--cu-[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]!.trim()]));
}

describe('要件 11 章の HEX', () => {
  it('ライト Mist Jade', () => {
    expect(LIGHT_TOKENS).toMatchObject({
      background: '#F4F8F5', surface: '#FFFFFF', border: '#DCE6DF', textPrimary: '#1D2923',
      textSecondary: '#617366', accent: '#087D65', onAccent: '#FFFFFF',
    });
  });
  it('ダーク Jade Teal', () => {
    expect(DARK_TOKENS).toMatchObject({
      background: '#08090B', surface: '#121316', border: '#26272B', textPrimary: '#F2F1F2',
      textSecondary: '#929095', accent: '#42C7AE', onAccent: '#08090B',
    });
  });
  it('styles.css のトークン定義が tokens.ts と一致', () => {
    const light = cssBlock("[data-theme='light']");
    const dark = cssBlock(":root[data-theme='dark']");
    for (const k of Object.keys(LIGHT_TOKENS) as (keyof ThemeTokens)[]) {
      expect(light[cssVarName(k)], k).toBe(LIGHT_TOKENS[k]);
      expect(dark[cssVarName(k)], k).toBe(DARK_TOKENS[k]);
    }
  });
  it('HEX はトークン定義以外に散在しない', () => {
    const rest = css.replace(/:root,\s*:root\[data-theme='light'\] \{[^}]*\}/, '').replace(/:root\[data-theme='dark'\] \{[^}]*\}/, '');
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });
  it('両テーマで accent は別の値', () => {
    expect(LIGHT_TOKENS.accent).not.toBe(DARK_TOKENS.accent);
  });
});

describe('コントラスト比', () => {
  for (const [name, t] of [['light', LIGHT_TOKENS], ['dark', DARK_TOKENS]] as const) {
    describe(name, () => {
      const text: [string, string, string][] = [
        ['本文/背景', t.textPrimary, t.background],
        ['本文/surface', t.textPrimary, t.surface],
        ['本文/コード背景', t.textPrimary, t.codeBackground],
        ['補助/surface', t.textSecondary, t.surface],
        ['リンク・AIラベル/背景', t.accent, t.background],
        ['リンク/surface', t.accent, t.surface],
        ['投稿ボタン文字', t.onAccent, t.accent],
        ['投稿ボタン文字(hover)', t.onAccent, t.accentHover],
        ['危険/背景', t.danger, t.background],
        ['危険/surface', t.danger, t.surface],
      ];
      for (const [label, fg, bg] of text) {
        it(`${label} >= 4.5`, () => expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5));
      }
      const ui: [string, string, string][] = [
        ['フォーカス/背景', t.focusRing, t.background],
        ['フォーカス/surface', t.focusRing, t.surface],
        ['操作境界/背景', t.borderStrong, t.background],
        ['操作境界/surface', t.borderStrong, t.surface],
      ];
      for (const [label, fg, bg] of ui) {
        it(`${label} >= 3`, () => expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(3));
      }
    });
  }

  it('ライト textSecondary/background >= 4.5（#65776B から #617366 へ調整済み）', () => {
    expect(contrastRatio(LIGHT_TOKENS.textSecondary, LIGHT_TOKENS.background)).toBeGreaterThanOrEqual(4.5);
  });
  it('ダーク textSecondary/background >= 4.5', () => {
    expect(contrastRatio(DARK_TOKENS.textSecondary, DARK_TOKENS.background)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('初回描画前のテーマ解決', () => {
  const run = (stored: string | null, prefersDark: boolean) => {
    if (stored) localStorage.setItem(THEME_STORAGE_KEY, stored);
    else localStorage.removeItem(THEME_STORAGE_KEY);
    const orig = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: prefersDark && q.includes('dark') })) as unknown as typeof window.matchMedia;
    document.documentElement.removeAttribute('data-theme');
    new Function(getThemeInitScript())();
    window.matchMedia = orig;
    return [document.documentElement.dataset.theme, document.documentElement.style.colorScheme];
  };
  it('保存なし → OS 設定', () => {
    expect(run(null, true)).toEqual(['dark', 'dark']);
    expect(run(null, false)).toEqual(['light', 'light']);
  });
  it('手動選択を優先', () => {
    expect(run('light', true)).toEqual(['light', 'light']);
    expect(run('dark', false)).toEqual(['dark', 'dark']);
  });
  it('不正値は system 扱い', () => {
    expect(run('purple', true)[0]).toBe('dark');
  });
  it('resolveTheme', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
});
