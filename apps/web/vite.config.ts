import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
// 相対パスで読み込む（設定ファイルのバンドル時に TS ソースを取り込むため）
import { getThemeInitScript } from '../../packages/ui/src/theme/script';

const API_TARGET = process.env.CUENU_API_TARGET ?? 'http://localhost:8787';

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

const THEME_INIT_SCRIPT = getThemeInitScript();

/** 初回描画前のテーマ解決スクリプトを <head> 先頭に埋め込む（同期実行が必要なためインラインのまま、CSP は hash で許可） */
function themeInit(): Plugin {
  return {
    name: 'cuenu-theme-init',
    transformIndexHtml(html) {
      return html.replace('<!--%CUENU_THEME_INIT%-->', `<script>${THEME_INIT_SCRIPT}</script>`);
    },
  };
}

/**
 * Content-Security-Policy。インラインスクリプトはテーマ初期化の 1 本だけを sha256 で許可する。
 * - style-src 'unsafe-inline': React の style 属性・CSS 変数（MemoItem 等）や依存の動的スタイルを壊さないため
 * - img-src blob: data:: 添付画像のプレビュー（createObjectURL）と、Vite がインライン化した小さな画像
 * - connect-src 'self': API は同一オリジンの /api のみ（Gemini 等の外部 API はサーバー側から呼ぶ）
 */
function contentSecurityPolicy(): string {
  const hash = createHash('sha256').update(THEME_INIT_SCRIPT, 'utf8').digest('base64');
  return [
    "default-src 'self'",
    `script-src 'self' 'sha256-${hash}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
  ].join('; ');
}

/** 配信ヘッダー (dist/_headers) を CSP を埋めて生成（Cloudflare Workers 静的アセットが解釈する） */
function headers(): Plugin {
  return {
    name: 'cuenu-headers',
    apply: 'build',
    // index.html は vite の HTML プラグインが generateBundle で出力するため、その後に実行する
    generateBundle: {
      order: 'post',
      handler(_opts, bundle) {
      const html = bundle['index.html'];
      const src = html?.type === 'asset' ? String(html.source) : '';
      // index.html に埋め込まれたスクリプトとハッシュ対象が一致しなければ CSP で起動不能になるため止める
      if (!src.includes(`<script>${THEME_INIT_SCRIPT}</script>`)) this.error('index.html にテーマ初期化スクリプトが見つかりません');
      const template = readFileSync(join(__dirname, 'headers-template'), 'utf8');
      this.emitFile({ type: 'asset', fileName: '_headers', source: template.replace('__CUENU_CSP__', contentSecurityPolicy()) });
      },
    },
  };
}

/** ビルド成果物の一覧から Service Worker (dist/sw.js) を生成 */
function serviceWorker(): Plugin {
  return {
    name: 'cuenu-service-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const publicDir = join(__dirname, 'public');
      // _headers / _redirects は配信設定で、静的アセットとしては配信されない（SPA フォールバックの index.html が返る）
      const publicFiles = listFiles(publicDir).filter((p) => !/(^|[\\/])(\.DS_Store|_headers|_redirects)$/.test(p));
      const files = [
        '/', // index.html（Cloudflare 静的配信は /index.html を / へリダイレクトするため / で保持）
        ...Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'index.html' && f !== '_headers').map((f) => '/' + f),
        ...publicFiles.map((p) => '/' + relative(publicDir, p).split('\\').join('/')),
      ];
      const template = readFileSync(join(__dirname, 'sw-template.js'), 'utf8');
      // 版はファイル一覧・バンドル・public の中身・SW テンプレートから決める（どれが変わってもキャッシュを入れ替える）
      const h = createHash('sha256').update(files.join('\n')).update(template);
      for (const c of Object.values(bundle)) h.update(c.type === 'chunk' ? c.code : typeof c.source === 'string' ? c.source : Buffer.from(c.source));
      for (const p of publicFiles) h.update(readFileSync(p));
      const version = h.digest('hex').slice(0, 12);
      const source = template
        .replace('__CUENU_VERSION__', JSON.stringify(version))
        .replace('__CUENU_PRECACHE__', JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [react(), themeInit(), serviceWorker(), headers()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: API_TARGET, changeOrigin: false } },
  },
  preview: {
    port: 4173,
    proxy: { '/api': { target: API_TARGET, changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
