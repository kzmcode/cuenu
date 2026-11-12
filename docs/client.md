# @cuenu/core/client 設計メモ

ブラウザ（PWA）と Tauri WebView で共通に使うクライアント実装。React 非依存。`import { ... } from '@cuenu/core/client'`。
使い方・初期化手順は下記と `packages/core/src/client/index.ts` のエクスポートを参照。

## 構成

| ファイル | 役割 |
| --- | --- |
| `repo.ts` | `MemoRepository` 実装本体（保存方式に依存しない）。全メモをメモリにキャッシュし読み取りを高速化 |
| `backend.ts` / `idb-backend.ts` / `memory-backend.ts` | 保存方式。IndexedDB とインメモリ。どちらも「1 トランザクションで memos/ops/meta/images を書く」API |
| `ops.ts` | 送信キュー（PendingOp）の積み方・圧縮 |
| `sync.ts` / `sync-apply.ts` | 同期エンジン（push → pull）と結果の反映 |
| `images.ts` | 画像要約キュー |
| `search.ts` | 検索・ページング |
| `api-client.ts` | API の型付きラッパー、`ApiRequestError` |

## IndexedDB

- DB 名: `cuenu:<hash(正規化 serverUrl)>`、未接続は `cuenu:local`（`dbNameFor()`）。`dbName` で明示も可。
  接続先ごとに DB が別なので、前環境の未送信 op が別サーバーへ送られることはない。前環境のデータを移したい場合は `exportAll()` → `importBundle()`。
- ストア: `memos`（index byParent）/ `ops`（index byMemo, bySeq）/ `drafts` / `images`（一時画像。ArrayBuffer + mimeType）/ `meta`（deviceId, syncCursor, initialImportDone, lastSyncedAt, opSeq, schemaVersion）
- スキーマ版: `SCHEMA_VERSION`。変更時は `idb-backend.ts` の `upgrade()` に `if (oldVersion < N)` を追記する。upgrade 中の例外は versionchange トランザクションごと中止され、既存データは残る。
  別タブが新しい版で開こうとすると古いタブは接続を閉じて `onVersionChange` を呼ぶ（再読み込みを促す）。
- `navigator.storage.persist()` を起動時に要求（結果は `repo.persisted`）。
- 複数タブ/ウィンドウ: 書き込みは IDB の readwrite トランザクション内で read-modify-write するため同時操作で上書きしない。
  コミット後に BroadcastChannel（名前 = DB 名）で変更 ID を通知し、受信側はその ID を DB から読み直してキャッシュ更新 → `memo-changed`(origin `remote`)。
  同期と画像処理は Web Locks（`cuenu-sync:<db>` / `cuenu-images:<db>`）で全ウィンドウ1本に直列化（未対応環境はタブ内のみ）。

## 送信キューの規則

- 投稿 = ローカル保存成功。`create/updateBody/remove` はメモ保存と op 追加を同一トランザクションで行う。
- 1メモにつき未送信（送信中でない）upsert は最大1つ。編集はそれに圧縮する（新規 + 編集 → 新規1件、baseVersion=0, version=1）。
- 送信中の op がある間に編集した場合は、その op 適用後の版を baseVersion とする op を後ろに積む（送信中の編集を失わない）。
- 表示上の `version` は最後の op の `payload.version`（無ければサーバー版）。
- image のみの変更（要約状態）は `payload.version === baseVersion` の op（サーバーは version を上げない）。
- 削除は tombstone。親削除時は返信もローカルで tombstone 化し、op は親の delete 1件（サーバーが返信も tombstone 化）。
  `undoRemove` は未送信の delete op を取り除いて復元する（親と同時刻に消えた返信のみ戻す）。送信済みなら `cannot_undo`。
- 送信中フラグは同期ロック取得時に毎回リセット（中断したタブの残骸対策）。

## 同期

- push: 最大 100 件ずつ。結果の反映:
  - `applied` / `duplicate`: op を消し、後続 op が無ければサーバー版を採用。後続があれば本文はローカルのまま serverVersion/tags のみ更新
  - `conflict`: op と後続 upsert を破棄し、メモはサーバー版を表示、ローカル本文は `conflict.localBody` に保持（`syncState='conflict'`）。本文が同一 / image のみの op なら競合にせずサーバー版を採用
  - `gone`: 全 op 破棄、tombstone を採用（復活しない）
  - `rejected`: op を破棄し `syncState='error'`, `syncError=message`。ただし `contention_retry_later` / `internal_error`（サーバーの一時的失敗）は op を残し、pull 後にバックオフ再試行
- pull: `since` カーソルで `hasMore` の間取得し、同一トランザクションでカーソルを保存。tombstone は未送信 op より優先。未送信 op があるメモは本文・版・画像を上書きせず tags/serverSeq 等のみ更新。ローカル tombstone は復活させない。最後まで取り込んだら `initialImportDone=true`。
- `resolveConflict`: keep-server はサーバー版を採用、keep-local / `{ body }` は `baseVersion = server.version` の新 op。競合中の `updateBody` は `{ body }` での解決として扱う。
- 自動同期: `start()` で起動時・`online`・`visibilitychange`(visible)・60 秒ごと・ローカル変更 0.8 秒後。多重起動は1本化（実行中の呼び出しは1回の再実行にまとめる）。
- 失敗: 通信失敗・5xx は指数バックオフ（2 秒〜5 分、±20%）。429 は `retryAfterSec` 後。401 は `authRequired=true` で停止（ローカルデータは保持）、`updateConnection({ token })` で再開。

## 画像要約

1. `create({ body, image })` → `image.status='waiting'`, `baseVersion=1`, 一時画像を `images` に保存（本文は空でも可）
2. `processImages()`（start 中は起動・online・再表示・作成時に自動）: 元端末（`originDeviceId === deviceId`）かつ一時画像がある待機中のみ処理。可能なら `createImageBitmap` + `OffscreenCanvas` で長辺 1600px の JPEG に縮小 → `/api/images/summarize`
3. 成功: `version === baseVersion` かつ `editedAt === null`（＝作成後にユーザー編集なし）なら本文末尾へ追記（`applied=true`）。そうでなければ `image.summary` に保持し `applyImageSummary()` で反映。要約保存と同じトランザクションで一時画像を削除
   - `editedAt` 条件を加えているのは、同期前の編集は新規 op に圧縮され version が 1 のままになるため
4. 失敗: 429・通信失敗・401 は `waiting` に戻して待機（429 は Retry-After まで送らない）。それ以外は `failed`（画像は残す）→ `retryImageSummary` / `cancelImageSummary`（キャンセルで一時画像削除）
5. ログインで deviceId が変わった場合、`setDeviceId` が自端末の待機中画像の `originDeviceId` も更新する

## 検索

- 正規化: NFKC → 小文字 → カタカナをひらがなへ。正規化済み本文をメモごとにキャッシュ（本文変更時のみ再計算）。キーワードは空白区切りで AND、部分一致（`includes`）。
- 返信もヒットし `threadId` は親 ID。削除済み・削除済み親の返信は除外。タグ AND・author・`from <= createdAt < to`。
- 並びは新しい順（createdAt desc, id desc）。カーソルは `createdAt|id`、二分探索で位置を求める。同一ミリ秒の連続投稿でも順序が崩れないよう、作成時刻は端末内で単調増加させる。

### ベンチ結果（`src/client/__tests__/search-bench.test.ts`）

測定: 2026-11-04 / Apple M5 / macOS (darwin arm64) / Node v24.22.1 / vitest 3.2.7 / インメモリ backend（読み取り経路は IDB 版と同じキャッシュ）/ 1万件（返信約2割、本文 20〜100 語の日本語）/ 各5回。

| ケース | 中央値 ms | 最大 ms |
| --- | --- | --- |
| keyword 1語（ヒット多） | 0.06 | 0.20 |
| keyword 2語 AND | 0.07 | 0.08 |
| keyword ヒットなし（全件走査） | 0.71 | 20.26 |
| keyword ひらがな→カタカナ一致 | 0.05 | 0.11 |
| tags AND + author + 日付 | 0.19 | 0.27 |
| timeline 先頭30件 | 0.05 | 0.09 |
| 1件投稿→再検索 | 0.34 | 0.77 |

1万件投入（キャッシュ構築・正規化込み）75ms。目標 500ms に対して十分小さい。最大値の 20ms は初回 JIT。
未測定: 実機 iPhone Safari / WKWebView での IndexedDB からの起動時全件読み込み時間（fake-indexeddb は実機の参考にならない）。
