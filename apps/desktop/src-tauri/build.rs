// アプリ独自の Tauri command を ACL 管理下に置く（`allow-<command>` 権限が自動生成される）。
// ここに列挙した command は capabilities/*.json で許可したウィンドウからしか呼べない。
// command を追加したらここにも足し、使うウィンドウの capability に `allow-<command>` を加えること。
const COMMANDS: &[&str] = &[
    "get_settings",
    "set_shortcut",
    "set_notifications_enabled",
    "set_active_connection",
    "secret_set_token",
    "secret_get_token",
    "secret_delete_token",
    "hide_quick",
    "capture_screen",
    "pause_shortcut",
    "resume_shortcut",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
