# バックアップ・復旧・完全削除

## 基本方針

- 端末内保存が成功した時点で投稿は確定し、サーバー同期は後から行う。サーバーと同期済みの記録は別端末・再インストール後に再取得できる。
- 未送信の変更は端末内にだけある。アンインストール・データ削除・接続先変更の前に、同期の完了（設定 → 接続・同期 →「未送信 0 件」）を確認するか、エクスポートする。
- ブラウザ（PWA）の保存領域消去や OS による削除まで耐える保証はない。定期的なエクスポートを推奨。

## エクスポート / インポート

- 設定 → データ からエクスポート（JSON、`ExportBundle` 形式）・インポート。
- サーバー側の全データは `GET /api/export`（認証必須）でも取得できる。
- Mac 版の WebView からのファイル保存は未検証。うまく保存できない場合は PWA からエクスポートする。

## Mac 版のデータの場所

`<identifier>` は `tauri.conf.json` の identifier（`io.github.kzmcode.cuenu`）。

| データ | 場所 |
| --- | --- |
| 端末設定（ショートカット・通知・接続先） | `~/Library/Application Support/<identifier>/desktop-settings.json` |
| メモ・未送信キュー・下書き（IndexedDB） | `~/Library/WebKit/<identifier>/` 配下（WKWebView の保存先。場所は要検証） |
| 端末トークン | ログインキーチェーン、サービス名 `Cuenu`、アカウント `device-token:<envKey>` |

設定ファイルが壊れていた場合は `desktop-settings.json.broken` に退避して既定値で起動する（ローカルのメモは残る）。接続先を入れ直せば同じ環境のデータに戻る。

## よくある状況

| 状況 | 対応 |
| --- | --- |
| 「ログインが必要です」と表示される | トークン失効・Keychain 項目削除。通常ウィンドウの「ログイン」から同じサーバーへ再ログイン。ローカルのメモ・未送信は保持される |
| 接続先を間違えて切り替えた | 「接続先を変更・再ログイン」で元の URL に戻す。前の環境のデータ・未送信は残っており再送される |
| ショートカットが効かない | 他アプリと衝突している可能性。設定 →「Mac: クイック入力」で変更 |
| サーバー/アプリの互換性エラー | 表示に従い `brew upgrade --cask cuenu` またはサーバーを再デプロイ |
| 同期の競合 | タイムラインの「競合あり」から採用する内容を選ぶ（どちらも無言では消えない） |
| サーバーのパスワードを変えたい | `wrangler secret put OWNER_PASSWORD`。既存の端末はすべて失効するので、各端末で新しいパスワードで再ログインする（ローカルのメモ・未送信は保持される）。詳細は [server.md](server.md) |

## 完全削除

Mac 版を設定・ローカルデータごと削除する。**未送信の変更は失われる。**

```bash
brew uninstall --zap --cask cuenu
```

`zap` は Cask に定義したフォルダ（Application Support / WebKit / Caches / Preferences 等）を削除する。Keychain の端末トークンは削除されないため、必要なら手動で削除する:

```bash
security delete-generic-password -s Cuenu   # 項目ごとに繰り返す（見つからなくなるまで）
```

または「キーチェーンアクセス」で `Cuenu` を検索して削除。サーバー側の端末登録は、PWA の設定（端末一覧）から失効させる（`DELETE /api/devices/:deviceId`）。

サーバー（Cloudflare）ごと削除する場合は、Cloudflare ダッシュボードで Worker と D1 データベースを削除する。削除前に `GET /api/export` でエクスポートしておく。
