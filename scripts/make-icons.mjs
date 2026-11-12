// assets/icon-source.png（元画像）から、Apple のアイコンのように角を丸めた各サイズのアイコンを書き出す。
// 実行: node scripts/make-icons.mjs <chromium の実行ファイル>（playwright-core が必要）
//   出力: apps/web/public/icons/*, apps/web/public/favicon*.png, apps/desktop/src-tauri/icons/{app-1024.png,tray*.png}
//   その後 `pnpm --filter @cuenu/desktop tauri icon src-tauri/icons/app-1024.png` で .icns 等を再生成する
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const src = 'data:image/png;base64,' + readFileSync(join(root, 'assets/icon-source.png')).toString('base64');

// [出力パス, キャンバスの大きさ, 角丸の形を描く枠（余白込み）, 影]
const web = (p) => join(root, 'apps/web/public', p);
const tauri = (p) => join(root, 'apps/desktop/src-tauri/icons', p);
const jobs = [
  // macOS アプリ: Apple のテンプレートどおり 1024 の中に 824 の角丸、下に柔らかい影
  [tauri('app-1024.png'), 1024, { x: 100, y: 100, s: 824 }, true],
  // PWA・ブラウザ（余白なしで丸め、角は透明）
  [web('icons/icon-192.png'), 192, { x: 0, y: 0, s: 192 }, false],
  [web('icons/icon-512.png'), 512, { x: 0, y: 0, s: 512 }, false],
  [web('favicon-32.png'), 32, { x: 0, y: 0, s: 32 }, false],
  [web('favicon-16.png'), 16, { x: 0, y: 0, s: 16 }, false],
  // iOS のホーム画面アイコンは OS が角を丸めるため、正方形のまま（透明部分は黒くなる）
  [web('icons/apple-touch-icon.png'), 180, null, false],
];

const browser = await chromium.launch({ executablePath: process.argv[2] });
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');
for (const [out, size, box, shadow] of jobs) {
  const b64 = await page.evaluate(
    async ({ src, size, box, shadow }) => {
      const raw = new Image();
      raw.src = src;
      await raw.decode();
      // 元画像には灰色の外枠と角丸の黒い面が描き込まれているため、彩度の低い灰色を背景の黒に置き換える
      // （ティールの図形は彩度が高いので変わらない）
      const pre = document.createElement('canvas');
      pre.width = raw.naturalWidth;
      pre.height = raw.naturalHeight;
      const pg = pre.getContext('2d');
      pg.drawImage(raw, 0, 0);
      const data = pg.getImageData(0, 0, pre.width, pre.height);
      const px = data.data;
      // 背景は真っ黒より少し明るい色にし、左上から右下へゆるいグラデーションをかける（ダークテーマの面の色に寄せる）
      const TOP = [0x26, 0x26, 0x29]; // 左上（ほぼ黒。上ほどわずかに明るい）
      const BOTTOM = [0x10, 0x10, 0x12]; // 右下
      const W = pre.width, H = pre.height;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], gg = px[i + 1], bb = px[i + 2];
        const max = Math.max(r, gg, bb), min = Math.min(r, gg, bb);
        if (max - min < 14 && max < 60) {
          const p = (i / 4) % W, q = Math.floor(i / 4 / W);
          const t = Math.min(1, Math.max(0, (p / W) * 0.15 + (q / H) * 0.85));
          px[i] = Math.round(TOP[0] + (BOTTOM[0] - TOP[0]) * t);
          px[i + 1] = Math.round(TOP[1] + (BOTTOM[1] - TOP[1]) * t);
          px[i + 2] = Math.round(TOP[2] + (BOTTOM[2] - TOP[2]) * t);
        }
      }
      pg.putImageData(data, 0, 0);
      const img = pre;
      const c = document.getElementById('c');
      c.width = c.height = size;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.clearRect(0, 0, size, size);
      if (!box) {
        g.drawImage(img, 0, 0, size, size);
        return c.toDataURL('image/png').split(',')[1];
      }
      // 連続的な角（スーパー楕円 n=5）。Apple のアイコン形状に近い
      const path = new Path2D();
      const n = 5;
      const a = box.s / 2;
      const cx = box.x + a;
      const cy = box.y + a;
      for (let i = 0; i <= 720; i++) {
        const t = (i / 720) * Math.PI * 2;
        const ct = Math.cos(t);
        const st = Math.sin(t);
        const x = cx + a * Math.sign(ct) * Math.abs(ct) ** (2 / n);
        const y = cy + a * Math.sign(st) * Math.abs(st) ** (2 / n);
        i === 0 ? path.moveTo(x, y) : path.lineTo(x, y);
      }
      path.closePath();
      if (shadow) {
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.30)';
        g.shadowBlur = size * 0.028;
        g.shadowOffsetY = size * 0.012;
        g.fillStyle = '#08090B';
        g.fill(path);
        g.restore();
      }
      g.save();
      g.clip(path);
      g.drawImage(img, box.x, box.y, box.s, box.s);
      // 縁に細い明るい枠（上ほど明るく）。クリップ内に半分だけ描くので内側の枠になる
      if (box.s >= 40) {
        const edge = g.createLinearGradient(0, box.y, 0, box.y + box.s);
        edge.addColorStop(0, 'rgba(255,255,255,0.28)');
        edge.addColorStop(0.5, 'rgba(255,255,255,0.12)');
        edge.addColorStop(1, 'rgba(255,255,255,0.08)');
        g.strokeStyle = edge;
        g.lineWidth = Math.max(1.5, box.s * 0.012);
        g.stroke(path);
      }
      g.restore();
      return c.toDataURL('image/png').split(',')[1];
    },
    { src, size, box, shadow },
  );
  writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log('wrote', out.replace(root + '/', ''), size);
}
// メニューバー: macOS のテンプレート画像（モチーフだけを黒＋透明で描き、OS がメニューバーに合わせて白/黒にする）
for (const [out, size] of [[tauri('tray@2x.png'), 44], [tauri('tray.png'), 22]]) {
  const b64 = await page.evaluate(
    async ({ src, size }) => {
      const raw = new Image();
      raw.src = src;
      await raw.decode();
      const W = raw.naturalWidth, H = raw.naturalHeight;
      const pre = document.createElement('canvas');
      pre.width = W;
      pre.height = H;
      const pg = pre.getContext('2d');
      pg.drawImage(raw, 0, 0);
      const d = pg.getImageData(0, 0, W, H);
      const px = d.data;
      // 彩度（ティールらしさ）を不透明度にしてモチーフだけを取り出す
      let x0 = W, y0 = H, x1 = 0, y1 = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        const a = Math.max(0, Math.min(255, (sat - 20) * 3));
        px[i] = px[i + 1] = px[i + 2] = 0;
        px[i + 3] = a;
        if (a > 128) {
          const x = (i / 4) % W, y = Math.floor(i / 4 / W);
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      pg.putImageData(d, 0, 0);
      const c = document.getElementById('c');
      c.width = c.height = size;
      const g = c.getContext('2d');
      g.clearRect(0, 0, size, size);
      g.imageSmoothingQuality = 'high';
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const fit = size * 0.82;
      const k = fit / Math.max(bw, bh);
      const dw = bw * k, dh = bh * k;
      g.drawImage(pre, x0, y0, bw, bh, (size - dw) / 2, (size - dh) / 2, dw, dh);
      return c.toDataURL('image/png').split(',')[1];
    },
    { src, size },
  );
  writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log('wrote', out.replace(root + '/', ''), size, '(template)');
}
await browser.close();
