import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
// 初回描画前にテーマを解決するインラインスクリプト（担当C の @cuenu/ui/theme-script。React 非依存）
import { getThemeInitScript } from '../../packages/ui/src/theme/script';

/**
 * <head> の `<!--cuenu-theme-init-->` をインライン script に置換する。
 * Tauri はビルド時に frontendDist の HTML 内インライン script のハッシュを CSP に追加する。
 */
function themeInit(): Plugin {
  return {
    name: 'cuenu-theme-init',
    transformIndexHtml: (html) => html.replace('<!--cuenu-theme-init-->', `<script>${getThemeInitScript()}</script>`),
  };
}

// Tauri から読み込む Vite マルチページ（通常ウィンドウ index.html / クイック入力 quick.html）。
// 両ページは同一オリジンなので IndexedDB・localStorage を共有する。
export default defineConfig({
  plugins: [react(), themeInit()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'safari15',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        quick: fileURLToPath(new URL('./quick.html', import.meta.url)),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
