# Cuenu

Cuenu（キューヌ）は自分専用のメモアプリ。雑に書いた記録がタイムラインに溜まり、AI があとから関連や次の行動を見つけて同じタイムラインに投稿する。提案への採用・見送り・経過は、自由文のリプライとして残す。

- Mac（クイック入力 + 通常ウィンドウ）とスマホ（PWA）で同じ記録を使う
- 端末内保存が先。通信や AI の完了を待たずに投稿でき、オフラインでも閲覧・検索・編集できる
- PWA・サーバーは**各自の Cloudflare アカウント**にデプロイする（1 デプロイ = 1 利用者）。Mac 版は共通のビルド済みアプリを Homebrew Cask で配布
- クレジットカード・請求先登録なしの無料枠で動く構成を標準とする（無料枠の将来の提供は保証されない）



## クイックスタート

自分の Cloudflare アカウントにサーバーと PWA を置き、スマホと Mac から使うまでの流れ。

```bash
git clone https://github.com/kzmcode/cuenu.git
cd cuenu
corepack enable          # pnpm を使えるようにする（初回だけ）
pnpm setup:deploy        # ログイン → D1 作成 → ビルド → デプロイ → パスワード等の登録
```

最後に表示される `https://cuenu.<あなたのサブドメイン>.workers.dev` が自分専用の URL になる。

1. **スマホ**: その URL を Safari で開き、共有 →「ホーム画面に追加」。ホーム画面から開いて所有者パスワードでログインする
2. **Mac**: Homebrew で入れて（[下記](#mac-版)）、初回起動で URL と所有者パスワードを入力する

## 必要なもの


| もの                   | 用途                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| Cloudflare アカウント（無料） | サーバー・PWA の置き場所。未登録ならスクリプトのログイン画面から作れる                                                              |
| Node 24 以上           | セットアップスクリプトの実行（[nvm](https://github.com/nvm-sh/nvm) なら `nvm install && nvm use` で `.nvmrc` の版が入る）  |
| pnpm 12              | `corepack enable` で `package.json` の版が使われる                                                         |
| Gemini API キー（任意）    | AI 機能（タグ付け・提案・意味検索・画像要約）。[Google AI Studio](https://aistudio.google.com/apikey) で無料発行。なくても記録・同期は動く |


## セルフデプロイ（PWA + サーバー）

### `pnpm setup:deploy` がすること

初回も更新も同じコマンドで、何度実行してもよい。すでに済んでいる手順は飛ばす。


| 手順                 | 内容                                                                               |
| ------------------ | -------------------------------------------------------------------------------- |
| 1. ツール確認・依存導入      | Node / pnpm の版を確認し、`pnpm install`                                                |
| 2. Cloudflare ログイン | 未ログインならブラウザでログイン（`wrangler login`）。複数アカウントに入れる場合はデプロイ先を選ぶ                        |
| 3. D1 の用意          | D1 `cuenu` がなければ作成し、`apps/server/wrangler.jsonc` の `database_id` を自分の D1 に合わせる   |
| 4. ビルド・反映          | PWA をビルドし、D1 マイグレーションを適用して Worker をデプロイ                                          |
| 5. Secret の登録      | 未登録の Secret だけ登録する。所有者パスワードと Gemini API キーは入力（画面に表示しない）、Web Push 用の VAPID 鍵は自動生成 |



| オプション              | 内容                                    |
| ------------------ | ------------------------------------- |
| `--check`          | ログインと D1 の確認だけして、何も変更しない              |
| `--reset-password` | 所有者パスワードを登録し直す（変更前にログインした端末はログアウトされる） |


```bash
pnpm setup:deploy --check
pnpm setup:deploy --reset-password
```

- 所有者パスワードは 12 文字以上。入力を空のまま Enter を押すと、ランダムなパスワードを作って一度だけ表示する
- 秘密情報は Wrangler へ標準入力で渡すので、ファイルやコマンド履歴に残らない
- 環境変数 `CLOUDFLARE_API_TOKEN` があると、ブラウザのログインではなくそのトークンのアカウントにデプロイする。ブラウザでログインしたアカウントを使うなら `env -u CLOUDFLARE_API_TOKEN pnpm setup:deploy`
- 手作業で行う場合の手順は [docs/server.md](docs/server.md#デプロイ利用者が自分のアカウントで行う)

### 更新

```bash
git pull
pnpm setup:deploy
```

GitHub Actions からデプロイする場合は `.github/workflows/deploy-cloudflare.yml` を手動実行する（[docs/release.md](docs/release.md#pwa--サーバー)）。

### 登録される Secret

リポジトリや PWA のビルド成果物には含めず、Worker の Secret として登録する。


| Secret                                                     | 必須  | 内容                                                                                        |
| ---------------------------------------------------------- | --- | ----------------------------------------------------------------------------------------- |
| `OWNER_PASSWORD`                                           | 必須  | 所有者ログイン用パスワード（PWA・Mac のログインで使う。AI キーとは別）                                                  |
| `GEMINI_API_KEY`                                           | 任意  | Gemini API キー。あとから登録するなら `cd apps/server && pnpm exec wrangler secret put GEMINI_API_KEY` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | 任意  | Web Push 用。スクリプトが自動生成する                                                                   |


### Gemini 無料枠とデータ利用に関する注意

Gemini API の無料枠では、送信した入力・出力が Google の製品改善に利用される場合がある。AI 機能を有効にすると、メモの本文や画像が Gemini に送信される。利用前に公式の [料金・データ利用区分](https://ai.google.dev/gemini-api/docs/pricing) と [課金区分](https://ai.google.dev/gemini-api/docs/billing/) を確認すること。外部送信を許可することと、学習に使われない保証は別である。AI を使わない場合は `GEMINI_API_KEY` を登録しないか、設定で AI を無効にする。

## Mac 版

Apple Silicon 向け。Apple Developer ID 署名・公証なし（初回起動時に許可操作が必要。[docs/install-mac.md](docs/install-mac.md)）。

```bash
brew tap kzmcode/tap
brew trust kzmcode/tap   # Homebrew 7 以降は、公式以外の Tap を信頼済みにしないと読み込まない
brew install --cask cuenu
```

1. 起動すると止められるので、「システム設定」→「プライバシーとセキュリティ」→「このまま開く」で許可する
2. サーバー URL と所有者パスワードを入力して接続する
3. どのアプリからでも ⌃⌘M でクイック入力を開ける（設定で変更可）

更新は `brew update && brew upgrade --cask cuenu`。メモ・設定・ログイン状態は更新後も残る。通常のアンインストール（`brew uninstall --cask cuenu`）ではメモ・設定を削除しない（完全削除は `--zap`）。

### ソースからビルド

前提: macOS（Apple Silicon）、Xcode Command Line Tools、[Rust](https://rustup.rs)（stable）、Node 24、pnpm 12。

```bash
pnpm install
pnpm --filter @cuenu/desktop tauri build
# → apps/desktop/src-tauri/target/release/bundle/macos/Cuenu.app
#   apps/desktop/src-tauri/target/release/bundle/dmg/Cuenu_<version>_aarch64.dmg
```

フォークして自分で配布する場合は `tauri.conf.json` の `identifier`（`io.github.kzmcode.cuenu`）を自分の識別子に変える（[docs/desktop.md](docs/desktop.md#identifierバンドルid)）。配布の手順は [docs/release.md](docs/release.md)。

## 開発

```bash
pnpm setup:dev       # 依存導入・apps/server/.dev.vars の作成（VAPID 鍵も生成）・ローカル D1 の準備
pnpm dev:server      # API サーバー  http://localhost:8787（ログインパスワードは dev-password）
pnpm dev:web         # PWA          http://localhost:5173（別ターミナルで）
pnpm dev:desktop     # Mac アプリ（Rust が必要）
pnpm typecheck
pnpm test
```

`pnpm setup:dev` は既存の `.dev.vars` を上書きせず、空の項目だけ埋める。ターミナルから実行すると Gemini API キーを聞かれる（空のまま Enter で省略）。

## 構成

```text
cuenu/
├── apps/
│   ├── web/       # PWA（@cuenu/web）
│   ├── desktop/   # Mac 版 Tauri v2 + Rust（@cuenu/desktop）
│   └── server/    # Cloudflare Workers + D1 + Cron + Gemini + Web Push（@cuenu/server）
├── packages/
│   ├── ui/        # 共通画面・テーマ・部品（@cuenu/ui）
│   └── core/      # データ型・API 契約・端末内保存・同期（@cuenu/core）
├── scripts/       # セットアップ（setup.mjs）・アイコン生成
├── packaging/homebrew/cuenu.rb  # Homebrew Cask テンプレート
├── .github/workflows/           # CI・Mac リリース・Cloudflare デプロイ（任意）
└── docs/
```


| ドキュメント                                     | 内容                             |
| ------------------------------------------ | ------------------------------ |
| [docs/server.md](docs/server.md)           | サーバー・API・Secret・定期処理・手作業でのデプロイ |
| [docs/client.md](docs/client.md)           | 端末内保存・同期・競合                    |
| [docs/ui.md](docs/ui.md)                   | 画面・テーマ                         |
| [docs/desktop.md](docs/desktop.md)         | Mac 版の構成・動作・開発                 |
| [docs/install-mac.md](docs/install-mac.md) | Mac 版の導入・初回起動・更新・アンインストール      |
| [docs/release.md](docs/release.md)         | リリース手順（配布者向け）・必要な Secret       |
| [docs/recovery.md](docs/recovery.md)       | バックアップ・復旧・完全削除                 |


## 未検証の項目

- Mac: クイック入力の呼び出し 300ms 目標、IME 変換中の ⌘Enter、元のアプリへのフォーカス復帰、WebView からのエクスポート
- Mac: Intel / Universal Binary、最低対応 macOS（仮置き 11.0）
- 無料枠内での意味検索・Web Push の暗号処理の CPU 時間
- iPhone PWA のキーボード自動表示、Web Push の受信
- `pnpm setup:deploy` の、まだ何もないアカウントでの初回実行（D1 作成・Secret 登録まで）

## 未確定の項目

- Dock 表示方針（現在は Dock に表示）

## ライセンス

[MIT](LICENSE)