# Cuenu の Homebrew Cask テンプレート。
# Tap リポジトリ kzmcode/homebrew-tap の Casks/cuenu.rb として置く。
# release-desktop.yml が version / sha256 / ソースリポジトリ（YOUR_ID/cuenu の部分）を置換して Tap に PR（または push）する。
# 公開元は kzmcode/cuenu（フォークして自分で配布する場合はリリース時に自分のリポジトリへ置換される）。
#
# 署名: Apple Developer ID 署名・公証なし（ad-hoc 署名のみ）。初回起動時の操作は docs/install-mac.md を参照。
# データ: 通常の `brew uninstall --cask cuenu` ではメモ・未送信データ・設定・Keychain の端末トークンを削除しない。
#         完全削除は `brew uninstall --zap --cask cuenu` と docs/recovery.md の手順（Keychain 項目は手動削除）。
cask "cuenu" do
  version "0.1.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/YOUR_ID/cuenu/releases/download/v#{version}/Cuenu_#{version}_aarch64.dmg"
  name "Cuenu"
  desc "Personal memo timeline with AI suggestions for a self-hosted server"
  homepage "https://github.com/YOUR_ID/cuenu"

  # Apple Silicon のみ（Intel / Universal Binary は未対応・未検証）
  depends_on arch: :arm64
  depends_on macos: ">= :big_sur"

  app "Cuenu.app"

  # identifier（tauri.conf.json）を変更した場合はここのパスも合わせる
  zap trash: [
    "~/Library/Application Support/io.github.kzmcode.cuenu",
    "~/Library/Caches/io.github.kzmcode.cuenu",
    "~/Library/HTTPStorages/io.github.kzmcode.cuenu",
    "~/Library/Preferences/io.github.kzmcode.cuenu.plist",
    "~/Library/Saved Application State/io.github.kzmcode.cuenu.savedState",
    "~/Library/WebKit/io.github.kzmcode.cuenu",
  ]

  caveats <<~EOS
    Cuenu is ad-hoc signed and not notarized by Apple. On first launch macOS
    Gatekeeper will block it. To approve it:
      1. Try to open Cuenu once (it will be blocked).
      2. Open System Settings > Privacy & Security, scroll to the Security section
         and click "Open Anyway" next to Cuenu, then confirm.

    On first launch, enter the URL of your own Cuenu server and its owner password.
    The screenshot button needs Screen Recording permission. After upgrading, macOS
    may ask for Screen Recording and Keychain access again because the ad-hoc
    signature changes with every build. Notes and settings are kept on uninstall;
    use `brew uninstall --zap --cask cuenu` to remove them.
  EOS
end
