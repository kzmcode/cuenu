# Mac 版（apps/desktop）

Tauri v2 + Rust。画面は `@cuenu/ui`、端末内保存・同期は `@cuenu/core/client`（IndexedDB 版）を使う。

## 構成

| 場所 | 内容 |
| --- | --- |
| `apps/desktop/index.html` → `src/main.tsx` | 通常ウィンドウ（label `main`）。初回セットアップ、`CuenuApp`、同期、Mac 通知 |
| `apps/desktop/quick.html` → `src/quick.tsx` | クイック入力ウィンドウ（label `quick`）。`CuenuQuickInput` |
| `src/connection.ts` | サーバーURL正規化、`/api/health` 互換性確認、ログイン、接続先切替の判定 |
| `src/shortcut.ts` | ショートカットの入力・検証・表示・保存 |
| `src/notifier.ts` | AI 新着の検知と通知 |
| `src/platform.ts` | `@cuenu/ui` に渡す `CuenuPlatform`（auth / server / notifications） |
| `src-tauri/src/lib.rs` | ウィンドウ制御、グローバルショートカット、トレイ、Tauri command |
| `src-tauri/src/settings.rs` | 端末設定ファイル（ショートカット・通知・接続先） |
| `src-tauri/src/secrets.rs` | Keychain（端末トークン） |
| `src-tauri/build.rs`, `src-tauri/capabilities/{main,quick}.json` | ウィンドウごとの IPC 権限（下記） |

両ウィンドウは同一オリジン（`tauri://localhost`）なので同じ IndexedDB を共有する。他ウィンドウの変更は `@cuenu/core` の BroadcastChannel で反映される。同期は通常ウィンドウだけで動かす。

IPC はウィンドウごとに最小権限。独自 command は `build.rs` の `AppManifest::commands` で ACL 管理下に置き（`allow-<command>` が自動生成）、capability で許可する。command を追加したら両方を更新する。

- `main`: 全 command（設定・ショートカット・接続先・Keychain トークン・撮影）、イベント購読、通知。
- `quick`: `get_settings`（接続先の serverUrl/deviceId で DB を開くだけ。トークン不要）、`hide_quick`、`capture_screen`、イベント購読、ドラッグ。
- トークン操作・接続先変更・ショートカット変更は Rust 側でも呼び出し元ラベルが `main` か確認する。

## ウィンドウの動作

- クイック入力: 起動時に非表示で生成して常駐。装飾なし・最前面・Dock/タスク切替に出さない。グローバルショートカットで表示し即フォーカス。
  - ⌘Enter: 端末内に保存できたら隠す。保存失敗時は本文を残して閉じない。
  - Esc: 下書きを保持して隠す（下書きは `quick` キーで保存）。
  - 隠す時、通常ウィンドウが表示されていなければアプリごと隠し、直前のアプリへフォーカスを戻す。
- 通常ウィンドウ: サイズ変更可。閉じても破棄せず隠すだけ（常駐・ショートカット有効のまま）。Dock アイコンのクリックで再表示。
- 完全終了: メニュー「Cuenu → 終了」（⌘Q）またはメニューバーのトレイ「Cuenu を終了」。

### Dock とメニューバー（仮方針）

- Dock アイコンは表示する（通常のアプリとして動作）。macOS 標準の編集メニュー（コピー・貼り付け）と ⌘Q をそのまま使えるため。
- メニューバーにトレイアイコンを常駐（クイック入力 / Cuenu を開く / 終了）。アイコンはアプリアイコンの流用で、テンプレート画像（モノクロ）化は未対応。
- Dock 非表示（メニューバー専用アプリ）にするかは未確定。

## グローバルショートカット

- 初期値は **⌃⌘M**（`Control+Super+M`）。⌘M（最小化）・⌃⌥Space（入力ソース切替）は標準操作と衝突するため使わない。以前の初期値 ⌃⌥Space のまま変更していない設定は、起動時に ⌃⌘M へ移行する
- 設定画面でショートカット欄を押し、新しいキーを実際に押して決める（押している修飾キーをその場で表示、Esc で中止）。記録中は今のショートカットを一時的に外す（`pause_shortcut`/`resume_shortcut`）
- ⌘＋文字も登録できる（例 ⌘M。その場合、他のアプリの同じ操作＝⌘M の最小化 などは使えなくなる）。⌘Q・⌘W・⌘Tab・⌘Space・⌃Space・⌃⌥Space・⌃⌘Space・⌃⌘Q・⌃⌘F は標準操作と衝突するため受け付けない
- 設定画面「Mac: クイック入力」で変更できる。新しいショートカットを登録できた場合だけ旧ショートカットを解除して保存する（他アプリと衝突して登録できなければ元のまま）。
- ⌘Q / ⌘W / ⌘Tab / ⌘Space / ⌃Space と、⌘⌃⌥ を含まない組み合わせは拒否する。
- 保存先: `~/Library/Application Support/<identifier>/desktop-settings.json`。

## 初回起動と接続

1. サーバーURLを入力（`https://` 必須。`http://localhost` / `127.0.0.1` は開発ビルドだけで許可。配布版の CSP（`security.csp`）は http を通さず、開発用の `security.devCsp` だけ localhost を許可する）。origin に正規化する。
2. `GET /api/health` で `name === 'cuenu'` と API 版を確認。サーバーが要求する `minClientApiVersion` よりアプリが古ければ「アプリを更新」、サーバーの `apiVersion` が古ければ「サーバーを再デプロイ」を表示する。
3. 所有者パスワード（サーバー Secret `OWNER_PASSWORD`）で `POST /api/auth/login`（`deviceName: "Mac"`、同じサーバーへの再ログインでは保存済み `deviceId` を送る）。
4. 端末トークンを macOS Keychain（汎用パスワード、サービス `Cuenu`、アカウント `device-token:<envKey>`）に保存し、成功後に接続先を確定。
5. トークンは JS 側に永続化しない。同期開始時に Keychain から取得して同期エンジンへ渡す。

トークンが失効（401）してもローカルデータは消さず、「ログインが必要です」と表示する。

### 接続先の変更とデータの分離

- ローカル DB は接続先ごとに別（`@cuenu/core` が `cuenu:<hash(serverUrl)>` を使う）。Keychain 項目も `envKey`（origin のハッシュ）で分ける。
- 同じサーバーへの再ログイン: データ・未送信はそのまま。
- 別サーバーへの切替: 前の環境のメモと未送信の変更は削除せず前環境の DB に残る。**新しい接続先には送信しない。** 前の環境に戻すと再送される。未送信がある場合は件数を示して確認を求める。必要なら切替前にエクスポートする。

## 通知

- 同期で受け取った `author='ai'` のトップレベル投稿を検知し、tauri-plugin-notification で通知する。
- 本文は既定で出さない（「新しいAIの提案があります」）。複数件はまとめる。通知済み ID を環境ごとに保持し、タグ更新等で同じ投稿を重複通知しない。初回取り込み中に届いた投稿は通知しない。
- iPhone（Web Push）とは別に、設定画面の「通知」で Mac だけ有効・無効を切り替える（初回有効化時に macOS の通知許可を要求）。
- 通知が出るのは Cuenu が起動中（ウィンドウを閉じて常駐中を含む）の場合だけ。完全終了中は出ない。

## identifier（バンドルID）

`tauri.conf.json` の `identifier` は **`io.github.kzmcode.cuenu`**（公開元 GitHub アカウント kzmcode）。フォークして自分で配布する場合は、自分が所有する識別子（例 `io.github.<自分のID>.cuenu`、小文字・英数字・ハイフン・ピリオドのみ）に置き換える。他者の識別子を流用しない。変更すると設定・ローカルデータの保存場所が変わる（既存利用者のデータは自動移行されない）ので、初回公開前に決める。`packaging/homebrew/cuenu.rb` の `zap` パスも合わせて変える。

## 開発・ビルド

前提: Node 24（`.nvmrc`）、pnpm 12、Rust（stable）、Xcode Command Line Tools。

```bash
pnpm install
pnpm dev:desktop                          # = pnpm --filter @cuenu/desktop tauri dev（Vite :1420）
pnpm --filter @cuenu/desktop test         # vitest（ショートカット・接続フロー・通知）
(cd apps/desktop/src-tauri && cargo test) # Rust（設定ファイル）
pnpm --filter @cuenu/desktop tauri build  # .app / .dmg（Apple Silicon）
```

- 成果物: `apps/desktop/src-tauri/target/release/bundle/{macos/Cuenu.app,dmg/Cuenu_<version>_aarch64.dmg}`
- DMG 作成時に Finder の AppleScript 操作で失敗する場合（「Finder に Apple Events を送信する権限がありません」）は、ターミナルにオートメーション権限を与えるか、`CI=true pnpm --filter @cuenu/desktop tauri build` で装飾を省略する。
- 署名は ad-hoc（`signingIdentity: "-"`）。Developer ID 署名・公証はしない。
- 開発時はサーバーの CORS に `http://localhost:1420` を追加する（`apps/server` の `CORS_ORIGINS`）。本番の `tauri://localhost` はサーバー側で既定許可。
- ブラウザで `pnpm --filter @cuenu/desktop dev` を直接開くと、開発用ブリッジ（トークンを localStorage に置く）で画面確認できる。配布ビルドでは使わない。

## アイコン

`assets/icon-source.png` から `scripts/make-icons.mjs` で角丸の `src-tauri/icons/app-1024.png` とメニューバー用 `tray*.png` を作り、`pnpm --filter @cuenu/desktop tauri icon src-tauri/icons/app-1024.png -o src-tauri/icons` で .icns 等を生成する（詳細は docs/ui.md のアイコン）。

## 未検証・既知の制約

- クイック入力の呼び出し速度（目標 300ms）、IME 変換中の ⌘Enter 無視の実機確認。
- アプリごと隠す方式で、元のアプリへ確実にフォーカスが戻るか（フルスクリーン・複数デスクトップ時）。
- 署名なし・ad-hoc 署名アプリでの Keychain アクセス: 更新（バイナリ変更）後に Keychain の許可ダイアログが出る可能性。
- WKWebView の IndexedDB 保存場所（`~/Library/WebKit/<identifier>` 想定）と、更新後の保持。
- `window.confirm` 等の JS ダイアログが WKWebView で表示されるか（UI 側の確認ダイアログで使用）。
- WebView 内からのエクスポート（ファイル保存）が動くか。
- Intel Mac・Universal Binary・最低対応 macOS（設定値は 11.0 の仮置き）は未検証。
