# Cuenu

Cuenu（キューヌ）は自分専用のメモアプリ。雑に書いた記録がタイムラインに溜まり、AI があとから関連や次の行動を見つけて同じタイムラインに投稿する。提案への採用・見送り・経過は、自由文のリプライとして残す。

- Mac（クイック入力 + 通常ウィンドウ）とスマホ（PWA）で同じ記録を使う
- 端末内保存が先。通信や AI の完了を待たずに投稿でき、オフラインでも閲覧・検索・編集できる
- PWA・サーバーは**各自の Cloudflare アカウント**にデプロイする（1 デプロイ = 1 利用者）。Mac 版は共通のビルド済みアプリを Homebrew Cask で配布
- クレジットカード・請求先登録なしの無料枠で動く構成を標準とする（無料枠の将来の提供は保証されない）

> 名称の商標上の確認は未完了。

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
├── packaging/homebrew/cuenu.rb  # Homebrew Cask テンプレート
├── .github/workflows/           # CI・Mac リリース・Cloudflare デプロイ（任意）
└── docs/
```

| ドキュメント | 内容 |
| --- | --- |
| [docs/server.md](docs/server.md) | サーバー・API・Secret・定期処理 |
| [docs/client.md](docs/client.md) | 端末内保存・同期・競合 |
| [docs/ui.md](docs/ui.md) | 画面・テーマ |
| [docs/desktop.md](docs/desktop.md) | Mac 版の構成・動作・開発 |
| [docs/install-mac.md](docs/install-mac.md) | Mac 版の導入・初回起動・更新・アンインストール |
| [docs/release.md](docs/release.md) | リリース手順（配布者向け）・必要な Secret |
| [docs/recovery.md](docs/recovery.md) | バックアップ・復旧・完全削除 |

## セルフデプロイ（PWA + サーバー）

Cloudflare の無料プラン（Workers Free + D1 Free）を使う。請求先の登録は不要。独自ドメインも不要（`*.workers.dev` を使う）。詳細・最新の手順は [docs/server.md](docs/server.md) を正とする。

### 必要なもの

- Cloudflare アカウント（無料）
- Gemini Developer API キー（AI 機能を使う場合。無料枠あり）
- Node 24・pnpm 12（手元からデプロイする場合）

### Deploy to Cloudflare ボタン

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kzmcode/cuenu/tree/main/apps/server)

ボタンはリポジトリの複製・D1 の作成・Worker のデプロイを簡略化するが、**ボタンだけで全設定は終わらない**。続けて下の「Secret の設定」「D1 マイグレーション」を行う。モノレポ（PWA のビルドを含む）でボタンが最後まで成功するかは未検証。

### 手元からデプロイ

```bash
pnpm install
pnpm --filter @cuenu/server exec wrangler login
pnpm --filter @cuenu/server exec wrangler d1 create cuenu
#   → 表示された database_id を apps/server/wrangler.jsonc の d1_databases[0].database_id に設定
pnpm --filter @cuenu/web build                      # PWA（Worker が同一オリジンで配信）
pnpm --filter @cuenu/server run db:migrate:remote   # D1 マイグレーション
pnpm --filter @cuenu/server run deploy
```

### Secret の設定

リポジトリや PWA のビルド成果物には含めない。`wrangler secret put` で Worker に登録する。

| Secret | 必須 | 内容 |
| --- | --- | --- |
| `OWNER_PASSWORD` | 必須 | 所有者ログイン用パスワード（PWA・Mac のログインで使う。AI キーとは別） |
| `GEMINI_API_KEY` | 任意 | Gemini Developer API キー。未設定でも記録・同期は動く |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | 任意 | Web Push 用。`pnpm --filter @cuenu/server run vapid:generate` で生成 |

```bash
cd apps/server
pnpm exec wrangler secret put OWNER_PASSWORD
pnpm exec wrangler secret put GEMINI_API_KEY
```

### D1 マイグレーション

初回と、サーバー更新でマイグレーションが増えたときに実行する。

```bash
pnpm --filter @cuenu/server run db:migrate:remote
```

### 更新

```bash
git pull
pnpm install
pnpm --filter @cuenu/web build
pnpm --filter @cuenu/server run db:migrate:remote
pnpm --filter @cuenu/server run deploy
```

GitHub Actions からデプロイする場合は `.github/workflows/deploy-cloudflare.yml` を手動実行する（Secret `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` に**自分の**値を登録。[docs/release.md](docs/release.md#pwa--サーバー)）。

### スマホ

デプロイした URL を Safari で開き、共有 →「ホーム画面に追加」。通知はホーム画面から起動した PWA で「通知を有効にする」。

### Gemini 無料枠とデータ利用に関する注意

Gemini API の無料枠では、送信した入力・出力が Google の製品改善に利用される場合がある。AI 機能を有効にすると、メモの本文や画像が Gemini に送信される。利用前に公式の [料金・データ利用区分](https://ai.google.dev/gemini-api/docs/pricing) と [課金区分](https://ai.google.dev/gemini-api/docs/billing/) を確認すること。外部送信を許可することと、学習に使われない保証は別である。AI を使わない場合は `GEMINI_API_KEY` を設定しないか、設定で AI を無効にする。

## Mac 版

Apple Silicon 向け。Apple Developer ID 署名・公証なし（初回起動時に許可操作が必要。[docs/install-mac.md](docs/install-mac.md)）。

```bash
brew tap kzmcode/tap
brew trust kzmcode/tap   # Homebrew 7 以降は、公式以外の Tap を信頼済みにしないと読み込まない
brew install --cask cuenu
```

更新:

```bash
brew update
brew upgrade --cask cuenu
```

Tap リポジトリは `kzmcode/homebrew-tap`。初回起動でサーバー URL と所有者パスワードを入力して接続する。通常のアンインストール（`brew uninstall --cask cuenu`）ではメモ・設定を削除しない。

### ソースからビルド

前提: macOS（Apple Silicon）、Xcode Command Line Tools、Rust（stable）、Node 24、pnpm 12。

```bash
pnpm install
pnpm --filter @cuenu/desktop tauri build
# → apps/desktop/src-tauri/target/release/bundle/macos/Cuenu.app
#   apps/desktop/src-tauri/target/release/bundle/dmg/Cuenu_<version>_aarch64.dmg
```

フォークして自分で配布する場合は `tauri.conf.json` の `identifier`（`io.github.kzmcode.cuenu`）を自分の識別子に変える（[docs/desktop.md](docs/desktop.md#identifierバンドルid)）。

## 開発

```bash
nvm use            # Node 24（.nvmrc）
pnpm install
pnpm dev:server    # http://localhost:8787
pnpm dev:web
pnpm dev:desktop
pnpm typecheck
pnpm test
```

## 未検証の項目

- Mac: 署名・公証なしアプリの初回起動手順（対象 macOS ごと）、Homebrew からの導入〜同期の通し確認、`brew upgrade` 後の設定・メモ・未送信・Keychain の保持、ad-hoc 署名での Keychain 許可ダイアログ
- Mac: クイック入力の呼び出し 300ms 目標、IME 変換中の ⌘Enter、元のアプリへのフォーカス復帰、WebView からのエクスポート
- Mac: Intel / Universal Binary、最低対応 macOS（仮置き 11.0）
- Deploy to Cloudflare ボタンでのモノレポ構成のデプロイ
- 無料枠内での意味検索・Web Push の暗号処理の CPU 時間
- iPhone PWA のキーボード自動表示、Web Push の受信
- GitHub Actions のリリース・Cask 更新ワークフローの実行（未実行）

## 未確定の項目

- Dock 表示方針（現在は Dock に表示）

## ライセンス

[MIT](LICENSE)
