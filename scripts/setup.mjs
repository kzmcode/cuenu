#!/usr/bin/env node
// Cuenu のセットアップ。依存は Node 標準モジュールだけ（pnpm install 前でも動く）。
//
//   pnpm setup:dev      ローカル開発の準備（依存の導入・.dev.vars・ローカル D1）
//   pnpm setup:deploy   自分の Cloudflare へデプロイ（初回・更新とも同じコマンド。何度実行してもよい）
//                       --reset-password を付けると所有者パスワードを登録し直す
//                       --check を付けると、ログインと D1 の確認だけして何も変更しない
//
// 秘密情報は画面に表示せず、Wrangler へは標準入力で渡す（ファイルやコマンド引数に残さない）。
import { spawn } from 'node:child_process';
import { randomBytes, webcrypto } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'apps/server');
const WRANGLER_CONFIG = join(SERVER, 'wrangler.jsonc');
const DEV_VARS = join(SERVER, '.dev.vars');
const MIN_PASSWORD = 12;
const env = { ...process.env };

const c = (n) => (s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const bold = c(1);
const dim = c(2);
const red = c(31);
const step = (s) => console.log(`\n${bold('▶')} ${bold(s)}`);
const info = (s) => console.log(`  ${s}`);
const warn = (s) => console.log(`  ${red('!')} ${s}`);

function fail(msg) {
  console.error(`\n${red('✗')} ${msg}`);
  process.exit(1);
}

/** コマンドを実行する。capture: 出力を受け取る（echo で画面にも出す）。input: 標準入力へ渡す文字列 */
function run(cmd, args, { cwd = ROOT, capture = false, echo = false, input } = {}) {
  return new Promise((resolve) => {
    const stdin = input !== undefined ? 'pipe' : 'inherit';
    const child = spawn(cmd, args, { cwd, env, stdio: capture ? [stdin, 'pipe', 'pipe'] : [stdin, 'inherit', 'inherit'] });
    let out = '';
    if (capture) {
      const take = (stream, sink) =>
        stream.on('data', (d) => {
          out += d;
          if (echo) sink.write(d);
        });
      take(child.stdout, process.stdout);
      take(child.stderr, process.stderr);
    }
    if (input !== undefined) child.stdin.end(input);
    child.on('error', (e) => resolve({ code: 127, out: String(e) }));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

async function must(cmd, args, opts, what) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) fail(`${what} に失敗しました（${cmd} ${args.join(' ')}）`);
  return r;
}

const wrangler = (args, opts = {}) => run('pnpm', ['exec', 'wrangler', ...args], { cwd: SERVER, ...opts });

// ---- 入力 ----

function ask(question, { hidden = false } = {}) {
  if (!process.stdin.isTTY) fail(`入力が必要です（${question}）。ターミナルから実行してください`);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // 入力した文字を表示しない
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
      };
    }
    rl.question(`  ${question}`, (a) => {
      if (hidden) rl.output.write('\n');
      rl.close();
      resolve(a.trim());
    });
  });
}

async function askPassword() {
  info(`所有者パスワード（PWA・Mac アプリのログインに使う。${MIN_PASSWORD} 文字以上）を決めます。`);
  info(dim('何も入力せずに Enter を押すと、ランダムなパスワードを作って一度だけ表示します。'));
  for (;;) {
    const p = await ask('パスワード: ', { hidden: true });
    if (!p) {
      const g = randomBytes(15).toString('base64url');
      info(`作成したパスワード: ${bold(g)}`);
      info(dim('いま表示したきりです。パスワードマネージャーなどに保存してください。'));
      return g;
    }
    if (p.length < MIN_PASSWORD) {
      warn(`${MIN_PASSWORD} 文字以上にしてください`);
      continue;
    }
    if ((await ask('もう一度: ', { hidden: true })) !== p) {
      warn('一致しません');
      continue;
    }
    return p;
  }
}

// ---- 共通 ----

async function checkTools() {
  step('必要なツールを確認');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) fail(`Node 24 以上が必要です（現在 ${process.version}）。nvm なら \`nvm install\` → \`nvm use\``);
  info(`Node ${process.version}`);
  const p = await run('pnpm', ['--version'], { capture: true });
  if (p.code !== 0) fail('pnpm が見つかりません。`corepack enable` を実行してから、もう一度実行してください');
  info(`pnpm ${p.out.trim()}`);
}

async function install() {
  step('依存パッケージを導入（pnpm install）');
  await must('pnpm', ['install'], {}, '依存パッケージの導入');
}

async function vapidKeys() {
  const b64url = (b) => Buffer.from(b).toString('base64url');
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await webcrypto.subtle.exportKey('raw', kp.publicKey);
  const jwk = await webcrypto.subtle.exportKey('jwk', kp.privateKey);
  return { VAPID_PUBLIC_KEY: b64url(pub), VAPID_PRIVATE_KEY: jwk.d };
}

// ---- ローカル開発 ----

function readDevVars() {
  const map = new Map();
  for (const line of readFileSync(DEV_VARS, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

function setDevVar(name, value) {
  const text = readFileSync(DEV_VARS, 'utf8');
  const re = new RegExp(`^${name}=.*$`, 'm');
  writeFileSync(DEV_VARS, re.test(text) ? text.replace(re, () => `${name}=${value}`) : `${text.trimEnd()}\n${name}=${value}\n`);
}

async function setupDev() {
  await checkTools();
  await install();

  step('ローカル用の設定ファイル（apps/server/.dev.vars）');
  if (!existsSync(DEV_VARS)) {
    copyFileSync(join(SERVER, '.dev.vars.example'), DEV_VARS);
    info('.dev.vars.example から作成しました');
  } else {
    info('既存の .dev.vars を使います（空の項目だけ埋めます）');
  }
  chmodSync(DEV_VARS, 0o600);
  const vars = readDevVars();
  if (!vars.get('VAPID_PUBLIC_KEY') || !vars.get('VAPID_PRIVATE_KEY')) {
    const k = await vapidKeys();
    setDevVar('VAPID_PUBLIC_KEY', k.VAPID_PUBLIC_KEY);
    setDevVar('VAPID_PRIVATE_KEY', k.VAPID_PRIVATE_KEY);
    info('Web Push 用の VAPID 鍵を作成しました');
  }
  if (!vars.get('GEMINI_API_KEY') && process.stdin.isTTY) {
    info('AI 機能を試すなら Gemini API キーを入力します（https://aistudio.google.com/apikey ）。');
    const key = await ask('Gemini API キー（使わないなら Enter）: ', { hidden: true });
    if (key) setDevVar('GEMINI_API_KEY', key);
  }
  info(`ローカルのログインパスワード: ${bold(readDevVars().get('OWNER_PASSWORD') || '(未設定)')}`);

  step('ローカルの D1 にテーブルを作成');
  await must('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'cuenu', '--local'], { cwd: SERVER }, 'ローカル D1 の準備');

  const cargo = await run('cargo', ['--version'], { capture: true });
  step('完了');
  info(`サーバー     ${bold('pnpm dev:server')}   → http://localhost:8787`);
  info(`PWA          ${bold('pnpm dev:web')}      → http://localhost:5173`);
  info(`Mac アプリ   ${bold('pnpm dev:desktop')}  ${cargo.code === 0 ? '' : red('（Rust が必要: https://rustup.rs ）')}`);
  info('サーバーと PWA は別々のターミナルで起動してください。');
}

// ---- Cloudflare へデプロイ ----

/** 複数アカウントに入れる場合、どのアカウントに置くかを決める（以後のコマンドへ CLOUDFLARE_ACCOUNT_ID で渡す） */
async function chooseAccount(whoami) {
  if (env.CLOUDFLARE_ACCOUNT_ID) return;
  const accounts = [...whoami.matchAll(/│\s*(.+?)\s*│\s*([0-9a-f]{32})\s*│/g)].map((m) => ({ name: m[1], id: m[2] }));
  if (accounts.length <= 1) return;
  info('使える Cloudflare アカウントが複数あります。');
  accounts.forEach((a, i) => info(`  ${i + 1}. ${a.name} (${a.id})`));
  for (;;) {
    const n = Number(await ask('デプロイ先の番号: '));
    if (accounts[n - 1]) {
      env.CLOUDFLARE_ACCOUNT_ID = accounts[n - 1].id;
      return;
    }
  }
}

async function ensureLogin() {
  step('Cloudflare へのログインを確認');
  if (env.CLOUDFLARE_API_TOKEN) {
    warn('環境変数 CLOUDFLARE_API_TOKEN が設定されています。このトークンのアカウントにデプロイします。');
    warn(dim('ブラウザでログインしたアカウントを使うなら、`env -u CLOUDFLARE_API_TOKEN pnpm setup:deploy` で実行してください。'));
  }
  let r = await wrangler(['whoami'], { capture: true });
  if (r.code !== 0 || /not authenticated|You are not logged in/i.test(r.out)) {
    if (env.CLOUDFLARE_API_TOKEN) fail('CLOUDFLARE_API_TOKEN で認証できませんでした');
    info('ブラウザで Cloudflare にログインします（アカウントがなければ無料で作れます）。');
    await must('pnpm', ['exec', 'wrangler', 'login'], { cwd: SERVER }, 'Cloudflare へのログイン');
    r = await wrangler(['whoami'], { capture: true });
  }
  const email = /associated with the email (\S+?)\.?\s/.exec(r.out)?.[1];
  info(email ? `ログイン中: ${email}` : 'ログイン済み');
  await chooseAccount(r.out);
  if (env.CLOUDFLARE_ACCOUNT_ID) info(`アカウント ID: ${env.CLOUDFLARE_ACCOUNT_ID}`);
}

async function listD1() {
  const r = await wrangler(['d1', 'list', '--json'], { capture: true });
  if (r.code !== 0) fail(`D1 の一覧を取得できませんでした\n${r.out}`);
  try {
    return JSON.parse(r.out.slice(r.out.indexOf('[')));
  } catch {
    fail(`D1 の一覧を読めませんでした\n${r.out}`);
  }
}

/** wrangler.jsonc の database_id が自分のアカウントの D1 を指すようにする（なければ作る） */
async function ensureD1({ check = false } = {}) {
  step('データベース（D1）を確認');
  const conf = readFileSync(WRANGLER_CONFIG, 'utf8');
  const name = /"database_name":\s*"([^"]+)"/.exec(conf)?.[1] ?? 'cuenu';
  const current = /"database_id":\s*"([^"]*)"/.exec(conf)?.[1] ?? '';
  let dbs = await listD1();
  let db = dbs.find((d) => d.uuid === current) ?? dbs.find((d) => d.name === name);
  if (!db && check) {
    info(`D1「${name}」はまだありません（本実行で作成します）`);
    return name;
  }
  if (!db) {
    info(`D1「${name}」を作成します`);
    await must('pnpm', ['exec', 'wrangler', 'd1', 'create', name], { cwd: SERVER }, 'D1 の作成');
    dbs = await listD1();
    db = dbs.find((d) => d.name === name);
    if (!db) fail('作成した D1 が見つかりません');
  }
  if (db.uuid !== current && check) {
    info(`D1「${db.name}」(${db.uuid}) があります（本実行で wrangler.jsonc の database_id をこれに合わせます）`);
  } else if (db.uuid !== current) {
    writeFileSync(WRANGLER_CONFIG, conf.replace(/("database_id":\s*")[^"]*(")/, `$1${db.uuid}$2`));
    info(`apps/server/wrangler.jsonc の database_id を ${db.uuid} に更新しました`);
  } else {
    info(`D1「${db.name}」(${db.uuid}) を使います`);
  }
  return db.name;
}

async function secretNames() {
  const r = await wrangler(['secret', 'list', '--format', 'json'], { capture: true });
  if (r.code !== 0) return new Set();
  try {
    return new Set(JSON.parse(r.out.slice(r.out.indexOf('['))).map((s) => s.name));
  } catch {
    return new Set();
  }
}

async function setupDeploy({ resetPassword, check }) {
  await checkTools();
  if (check) {
    await ensureLogin();
    await ensureD1({ check });
    step('確認のみ（--check）なので、ここで終了します');
    return;
  }
  await install();
  await ensureLogin();
  const dbName = await ensureD1();

  step('PWA をビルド');
  await must('pnpm', ['--filter', '@cuenu/web', 'build'], {}, 'PWA のビルド');

  step('D1 にマイグレーションを適用');
  await must('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', dbName, '--remote'], { cwd: SERVER }, 'マイグレーション');

  step('Worker をデプロイ');
  const d = await wrangler(['deploy'], { capture: true, echo: true });
  if (d.code !== 0) fail('デプロイに失敗しました');
  const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(d.out)?.[0];

  step('Secret（パスワード・API キー・通知用の鍵）を確認');
  const have = await secretNames();
  const put = {};
  if (!have.has('OWNER_PASSWORD') || resetPassword) put.OWNER_PASSWORD = await askPassword();
  else info('OWNER_PASSWORD は登録済み（変えるなら --reset-password）');
  if (!have.has('GEMINI_API_KEY')) {
    info('AI 機能を使うなら Gemini API キーを入力します（https://aistudio.google.com/apikey ）。');
    info(dim('無料枠では送ったメモが Google の改善に使われる場合があります（README の注意を参照）。あとから登録もできます。'));
    const key = await ask('Gemini API キー（使わないなら Enter）: ', { hidden: true });
    if (key) put.GEMINI_API_KEY = key;
  } else info('GEMINI_API_KEY は登録済み');
  if (!have.has('VAPID_PUBLIC_KEY') || !have.has('VAPID_PRIVATE_KEY')) {
    Object.assign(put, await vapidKeys());
    info('Web Push 用の VAPID 鍵を作成しました');
  }
  if (!have.has('VAPID_SUBJECT')) put.VAPID_SUBJECT = url ?? 'mailto:owner@example.invalid';
  if (Object.keys(put).length) {
    // 標準入力で渡す（ファイル・引数・画面に残さない）
    const r = await wrangler(['secret', 'bulk'], { capture: true, input: JSON.stringify(put) });
    if (r.code !== 0) fail(`Secret の登録に失敗しました\n${r.out}`);
    info(`登録しました: ${Object.keys(put).join(', ')}`);
  }

  step('完了');
  info(`URL: ${bold(url ?? '（デプロイの出力を確認してください）')}`);
  info('スマホ: この URL を Safari で開き、共有 →「ホーム画面に追加」。');
  info('Mac:    brew tap kzmcode/tap && brew trust kzmcode/tap && brew install --cask cuenu');
  info('        起動したら上の URL と所有者パスワードを入力します。');
  info(`更新:   ${bold('git pull && pnpm setup:deploy')}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'dev') await setupDev();
else if (cmd === 'deploy') await setupDeploy({ resetPassword: rest.includes('--reset-password'), check: rest.includes('--check') });
else fail('使い方: node scripts/setup.mjs dev | deploy [--reset-password] [--check]');
