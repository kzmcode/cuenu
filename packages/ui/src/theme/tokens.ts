// テーマトークン。基本7色は要件 11 章の HEX を厳守（変更禁止）。
// 派生トークンは ui 担当が定義（ホバー・押下・フォーカス・境界・危険・コード等）。
// CSS 側 (styles.css の :root) と一致することを test/theme.test.ts で検証する。

export type ResolvedTheme = 'light' | 'dark';

export interface ThemeTokens {
  background: string;
  surface: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  onAccent: string;
  // ---- 派生 ----
  accentHover: string;
  accentPressed: string;
  focusRing: string;
  /** 入力欄・ボタン等、操作に不可欠な境界（3:1 以上）。投稿間の薄い区切りは border */
  borderStrong: string;
  danger: string;
  codeBackground: string;
  hoverOverlay: string;
  selection: string;
}

/** ライト：L2 Mist Jade */
export const LIGHT_TOKENS: ThemeTokens = {
  background: '#F4F8F5',
  surface: '#FFFFFF',
  border: '#DCE6DF',
  textPrimary: '#1D2923',
  textSecondary: '#617366',
  accent: '#087D65',
  onAccent: '#FFFFFF',
  accentHover: '#066A56',
  accentPressed: '#055847',
  focusRing: '#087D65',
  borderStrong: '#7C8F83',
  danger: '#B3261E',
  codeBackground: '#E8EFEA',
  hoverOverlay: 'rgba(8, 125, 101, 0.06)',
  selection: 'rgba(8, 125, 101, 0.22)',
};

/** ダーク：F Jade Teal */
export const DARK_TOKENS: ThemeTokens = {
  background: '#08090B',
  surface: '#121316',
  border: '#26272B',
  textPrimary: '#F2F1F2',
  textSecondary: '#929095',
  accent: '#42C7AE',
  onAccent: '#08090B',
  accentHover: '#6AD6C1',
  accentPressed: '#86DECD',
  focusRing: '#42C7AE',
  borderStrong: '#6B6A70',
  danger: '#FF8A80',
  codeBackground: '#1A1B1F',
  hoverOverlay: 'rgba(66, 199, 174, 0.08)',
  selection: 'rgba(66, 199, 174, 0.30)',
};

export const THEME_TOKENS: Record<ResolvedTheme, ThemeTokens> = { light: LIGHT_TOKENS, dark: DARK_TOKENS };

/** トークン名 → CSS 変数名 (--cu-text-primary 等) */
export function cssVarName(key: keyof ThemeTokens): string {
  return '--cu-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`invalid hex: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG 2.x コントラスト比 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
