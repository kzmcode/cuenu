# リリース手順（配布者向け）

PWA・サーバーのデプロイ（各利用者が自分の環境で行う）と、Mac 版のリリース（配布者が行う）は別に実行する。

## Mac 版

### 初回だけ準備

1. `apps/desktop/src-tauri/tauri.conf.json` の `identifier` を自分の識別子に置き換える（[desktop.md](desktop.md#identifierバンドルid)）。`packaging/homebrew/cuenu.rb` の `zap` パスも合わせる。
2. Tap リポジトリ `<あなたのID>/homebrew-tap` を GitHub に作成（空でよい。既存の Tap があればそれを使う）。
3. fine-grained Personal Access Token を作成: 対象リポジトリ = Tap リポジトリのみ、権限 = Contents: Read and write / Pull requests: Read and write。
4. `cuenu` リポジトリの Settings → Secrets and variables → Actions に登録:

| 種別 | 名前 | 値 |
| --- | --- | --- |
| Secret | `HOMEBREW_TAP_TOKEN` | 手順 3 のトークン |
| Variable | `HOMEBREW_TAP_REPO` | `<あなたのID>/homebrew-tap` |
| Variable（任意） | `HOMEBREW_TAP_DIRECT_PUSH` | `true` で PR を作らず直接 push |

Release の作成はワークフローの `GITHUB_TOKEN` で行う（追加の Secret 不要）。Apple 関連の Secret は不要（署名・公証しない）。

### リリース

1. `apps/desktop/src-tauri/tauri.conf.json` と `apps/desktop/package.json` の `version` を上げる（例 `0.2.0`）。
2. コミットしてタグを push:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. `.github/workflows/release-desktop.yml` が実行される:
   - タグと `tauri.conf.json` の version を照合（不一致なら失敗）
   - macOS（Apple Silicon）ランナーで `tauri build` → `Cuenu_<version>_aarch64.dmg`
   - SHA-256 を計算し、DMG と `.sha256` を GitHub Releases に添付
   - `packaging/homebrew/cuenu.rb` から Cask を生成し、Tap に PR（または push）
4. Tap の PR を確認してマージ。利用者は `brew update && brew upgrade --cask cuenu` で更新できる。

既存タグの再ビルドは Actions の「Release desktop」→ Run workflow でタグ名を指定（Release の添付は上書き）。

### 手元でのリリース確認

```bash
CI=true pnpm --filter @cuenu/desktop tauri build
shasum -a 256 apps/desktop/src-tauri/target/release/bundle/dmg/Cuenu_*_aarch64.dmg
brew install --cask ./packaging/homebrew/cuenu.rb   # version / sha256 / URL を置き換えた一時コピーで
```

### 注意

- サーバー API の互換性を壊す変更をする場合は `packages/core/src/api.ts` の `API_VERSION` とサーバーの `minClientApiVersion` を検討する。Mac 版は起動時に互換性を確認し、更新手順を表示する。
- DB スキーマの変更（IndexedDB）は `@cuenu/core` 側で移行を実装し、更新後にローカル記録・未送信キューが残ることを確認してからリリースする。
- Tauri 内蔵の自動アップデーターは使わない（Homebrew で更新）。

## PWA + サーバー

利用者が自分の Cloudflare アカウントへデプロイする。手順は [README](../README.md#セルフデプロイpwa--サーバー) と [server.md](server.md)。

GitHub Actions でデプロイする場合（任意）: `.github/workflows/deploy-cloudflare.yml` を Actions から手動実行する。必要な Secret:

| Secret | 内容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 利用者自身の API トークン（Workers Scripts 編集・D1 編集の権限） |
| `CLOUDFLARE_ACCOUNT_ID` | 利用者の Cloudflare アカウント ID |

事前に手元で一度 `pnpm setup:deploy` を実行し、自分の D1 の ID に書き換わった `apps/server/wrangler.jsonc` をコミットしておく。サーバーの Secret（`OWNER_PASSWORD` 等）は workflow では登録しない（初回の `pnpm setup:deploy` で登録済みになる）。
