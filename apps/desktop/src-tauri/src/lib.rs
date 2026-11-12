//! Cuenu desktop（Tauri v2）。
//! - クイック入力ウィンドウ（label "quick"）は起動時に非表示で生成し常駐。グローバルショートカットで表示・即フォーカス。
//! - 通常ウィンドウ（label "main"）は閉じても破棄せず隠すだけ。アプリ完全終了はメニュー（⌘Q）/トレイから。

mod secrets;
mod settings;

use settings::{DesktopSettings, EnvConfig};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const MAIN: &str = "main";
const QUICK: &str = "quick";

struct AppState {
    dir: PathBuf,
    settings: Mutex<DesktopSettings>,
    /// 現在登録済みのショートカット（登録失敗時は None）
    shortcut: Mutex<Option<Shortcut>>,
    /// 直近の登録エラー（設定画面で表示）
    shortcut_error: Mutex<Option<String>>,
}

impl AppState {
    fn update<F: FnOnce(&mut DesktopSettings)>(&self, f: F) -> Result<DesktopSettings, String> {
        let mut s = self.settings.lock().map_err(|e| e.to_string())?;
        let mut next = s.clone();
        f(&mut next);
        settings::save(&self.dir, &next)?;
        *s = next.clone();
        Ok(next)
    }
}

fn show_quick(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(QUICK) {
        #[cfg(target_os = "macos")]
        let _ = app.show();
        let _ = w.show();
        let _ = w.set_focus();
        // JS 側で textarea にフォーカスし直す・下書きを読み直すための合図
        let _ = app.emit_to(QUICK, "quick:shown", ());
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        #[cfg(target_os = "macos")]
        let _ = app.show();
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn hide_quick_inner(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(QUICK) {
        let _ = w.hide();
    }
    // 通常ウィンドウが出ていなければアプリごと隠し、直前に使っていたアプリへフォーカスを戻す
    let main_visible = app
        .get_webview_window(MAIN)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    #[cfg(target_os = "macos")]
    if !main_visible {
        let _ = app.hide();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = main_visible;
}

fn register_shortcut(app: &AppHandle, accel: &str) -> Result<Shortcut, String> {
    let sc = Shortcut::from_str(accel).map_err(|e| format!("ショートカットを解釈できません: {e}"))?;
    app.global_shortcut()
        .register(sc)
        .map_err(|e| format!("ショートカットを登録できません（他のアプリが使用中の可能性）: {e}"))?;
    Ok(sc)
}

// ---------------- commands ----------------
// どのウィンドウがどの command を呼べるかは capabilities/*.json（build.rs の AppManifest）で絞る。
// 機密性の高いもの（トークン・接続先・ショートカット）は念のため呼び出し元ラベルも確かめる。

fn require_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == MAIN {
        Ok(())
    } else {
        Err("この操作は通常ウィンドウからのみ実行できます".into())
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    #[serde(flatten)]
    settings: DesktopSettings,
    shortcut_registered: bool,
    shortcut_error: Option<String>,
    default_shortcut: &'static str,
}

fn view(state: &AppState) -> Result<SettingsView, String> {
    Ok(SettingsView {
        settings: state.settings.lock().map_err(|e| e.to_string())?.clone(),
        shortcut_registered: state.shortcut.lock().map_err(|e| e.to_string())?.is_some(),
        shortcut_error: state.shortcut_error.lock().map_err(|e| e.to_string())?.clone(),
        default_shortcut: settings::DEFAULT_SHORTCUT,
    })
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Result<SettingsView, String> {
    view(&state)
}

/// 新しいショートカットを登録できた場合だけ旧ショートカットを解除して保存する。
/// 失敗時は旧設定のまま Err を返す。
#[tauri::command]
fn set_shortcut(app: AppHandle, window: tauri::WebviewWindow, state: tauri::State<'_, AppState>, accelerator: String) -> Result<SettingsView, String> {
    require_main(&window)?;
    let new_sc = Shortcut::from_str(&accelerator).map_err(|e| format!("ショートカットを解釈できません: {e}"))?;
    let mut current = state.shortcut.lock().map_err(|e| e.to_string())?;
    if current.as_ref().map(|c| c.id()) != Some(new_sc.id()) {
        register_shortcut(&app, &accelerator)?;
        if let Some(old) = current.take() {
            let _ = app.global_shortcut().unregister(old);
        }
        *current = Some(new_sc);
    }
    drop(current);
    *state.shortcut_error.lock().map_err(|e| e.to_string())? = None;
    state.update(|s| s.shortcut = accelerator)?;
    view(&state)
}

/// ショートカットの記録中は、いまのショートカットを一時的に外す
/// （押したキーがクイック入力を開いてしまい、設定画面に届かないのを防ぐ）
#[tauri::command]
fn pause_shortcut(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Some(sc) = state.shortcut.lock().map_err(|e| e.to_string())?.as_ref() {
        let _ = app.global_shortcut().unregister(*sc);
    }
    Ok(())
}

/// 記録をやめたら元に戻す（変更した場合は set_shortcut が新しいものを登録済み）
#[tauri::command]
fn resume_shortcut(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Some(sc) = state.shortcut.lock().map_err(|e| e.to_string())?.as_ref() {
        if !app.global_shortcut().is_registered(*sc) {
            app.global_shortcut().register(*sc).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn set_notifications_enabled(state: tauri::State<'_, AppState>, enabled: bool) -> Result<SettingsView, String> {
    state.update(|s| s.notifications_enabled = enabled)?;
    view(&state)
}

/// 接続先を確定（ログイン成功後）または解除（None）。トークンは別途 secret_set_token で保存する。
#[tauri::command]
fn set_active_connection(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    env: Option<EnvConfig>,
) -> Result<SettingsView, String> {
    require_main(&window)?;
    if let Some(e) = &env {
        e.validate()?;
    }
    state.update(|s| s.set_active(env))?;
    let _ = app.emit("connection:changed", ());
    view(&state)
}

#[tauri::command]
fn secret_set_token(window: tauri::WebviewWindow, env_key: String, token: String) -> Result<(), String> {
    require_main(&window)?;
    secrets::set_token(&env_key, &token)
}

#[tauri::command]
fn secret_get_token(window: tauri::WebviewWindow, env_key: String) -> Result<Option<String>, String> {
    require_main(&window)?;
    secrets::get_token(&env_key)
}

#[tauri::command]
fn secret_delete_token(window: tauri::WebviewWindow, env_key: String) -> Result<(), String> {
    require_main(&window)?;
    secrets::delete_token(&env_key)
}

#[tauri::command]
fn hide_quick(app: AppHandle) {
    hide_quick_inner(&app);
}

/// 画面の一部を選んで撮影し、PNG のバイト列を返す（キャンセル時は空）。
/// macOS 標準の `screencapture -i`（範囲選択・Esc で取り消し）を使う。
/// 撮影の間は呼び出し元のウィンドウを隠し、終わったら元に戻す。
/// 初回は macOS の「画面収録」の許可が必要（許可がないと他のアプリの内容が写らない）。
#[tauri::command]
async fn capture_screen(app: AppHandle, window: tauri::WebviewWindow) -> Result<tauri::ipc::Response, String> {
    #[cfg(target_os = "macos")]
    {
        let path = std::env::temp_dir().join(format!("cuenu-capture-{}.png", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let was_visible = window.is_visible().unwrap_or(false);
        let _ = window.hide();
        // 範囲選択の間ずっと待つので、非同期ランタイムのワーカーを塞がないよう別スレッドで実行する
        let capture_path = path.clone();
        let status = tauri::async_runtime::spawn_blocking(move || {
            // ウィンドウが画面から消えるのを待つ
            std::thread::sleep(std::time::Duration::from_millis(180));
            std::process::Command::new("/usr/sbin/screencapture")
                .args(["-i", "-x", "-o"])
                .arg(&capture_path)
                .status()
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r.map_err(|e| e.to_string()));
        if was_visible {
            let _ = app.show();
            let _ = window.show();
            let _ = window.set_focus();
        }
        status.map_err(|e| format!("スクリーンショットを撮れませんでした: {e}"))?;
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => Vec::new(), // 範囲選択を Esc で取り消した
        };
        let _ = std::fs::remove_file(&path);
        Ok(tauri::ipc::Response::new(bytes))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window);
        Err("この OS ではスクリーンショットの取り込みに対応していません".into())
    }
}

// ---------------- app ----------------

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let quick = MenuItem::with_id(app, "tray-quick", "クイック入力を開く", true, None::<&str>)?;
    let main = MenuItem::with_id(app, "tray-main", "Cuenu を開く", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Cuenu を終了", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quick, &main, &sep, &quit])?;
    let mut builder = TrayIconBuilder::with_id("cuenu-tray")
        .tooltip("Cuenu")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-quick" => show_quick(app),
            "tray-main" => show_main(app),
            "tray-quit" => app.exit(0),
            _ => {}
        });
    // メニューバー用: モチーフだけのテンプレート画像（44px = Retina の 22pt）。
    // macOS がメニューバーの明暗に合わせて白/黒に塗る
    match tauri::image::Image::from_bytes(include_bytes!("../icons/tray@2x.png")) {
        Ok(icon) => builder = builder.icon(icon).icon_as_template(true),
        Err(_) => {
            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }
        }
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        show_quick(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_shortcut,
            set_notifications_enabled,
            set_active_connection,
            secret_set_token,
            secret_get_token,
            secret_delete_token,
            hide_quick,
            capture_screen,
            pause_shortcut,
            resume_shortcut,
        ])
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let loaded = settings::load(&dir);
            let handle = app.handle().clone();
            let (registered, error) = match register_shortcut(&handle, &loaded.shortcut) {
                Ok(sc) => (Some(sc), None),
                Err(e) => (None, Some(e)),
            };
            app.manage(AppState {
                dir,
                settings: Mutex::new(loaded),
                shortcut: Mutex::new(registered),
                shortcut_error: Mutex::new(error),
            });
            build_tray(&handle)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 通常ウィンドウ・クイック入力とも破棄せず隠す（常駐・ショートカット有効のまま）
                api.prevent_close();
                if window.label() == QUICK {
                    let _ = window.emit_to(QUICK, "quick:close-requested", ());
                } else {
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Cuenu");

    app.run(|app, event| {
        // Dock アイコンのクリック（ウィンドウが無い状態）で通常ウィンドウを再表示
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { has_visible_windows, .. } = event {
            if !has_visible_windows {
                show_main(app);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}
