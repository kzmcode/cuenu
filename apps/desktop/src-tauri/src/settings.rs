//! 端末ローカルの desktop 設定（ショートカット・Mac 通知・接続先）。
//! 保存先: `<app_config_dir>/desktop-settings.json`（例 ~/Library/Application Support/<identifier>/）。
//! トークン等の秘密情報はここに保存しない（Keychain 側。secrets.rs）。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// 初期値 ⌃⌘M（Control+Command+M）。macOS の標準操作で使われておらず、M（Memo）で覚えやすい。
/// ⌘M は最小化、⌃⌥Space は入力ソース切替と衝突するため使わない。
pub const DEFAULT_SHORTCUT: &str = "Control+Super+M";
/// 以前の仮置きの初期値。変更されていなければ新しい初期値へ移行する
const LEGACY_DEFAULT_SHORTCUT: &str = "Control+Alt+Space";

const FILE_NAME: &str = "desktop-settings.json";

/// 接続先1件。env_key ごとにローカル DB と Keychain 項目を分離する。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvConfig {
    pub server_url: String,
    pub env_key: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopSettings {
    /// 設定ファイル形式の版（将来の移行用）
    pub format: u32,
    pub shortcut: String,
    /// Mac のネイティブ通知（iPhone の Web Push とは別設定）
    pub notifications_enabled: bool,
    /// 現在の接続先。未設定なら初回セットアップを表示
    pub active: Option<EnvConfig>,
    /// 過去に接続した環境（切替で戻れるように保持。ローカルデータは消さない）
    pub known: Vec<EnvConfig>,
}

/// env_key は DB 名・Keychain アカウント名に使うので英数字とハイフンだけ（connection.ts の envKeyFor の形式）
pub fn is_valid_env_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 64 && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// connection.ts の normalizeServerUrl と同じ条件の origin か（https。開発ビルドに限り localhost / 127.0.0.1 の http）
fn is_valid_server_origin(u: &str) -> bool {
    let (host_port, local_only) = if let Some(rest) = u.strip_prefix("https://") {
        (rest, false)
    } else if let Some(rest) = u.strip_prefix("http://") {
        (rest, true)
    } else {
        return false;
    };
    if host_port.is_empty() || host_port.chars().any(|c| matches!(c, '/' | '?' | '#' | '@' | '\\') || c.is_whitespace() || c.is_control()) {
        return false;
    }
    if local_only {
        // 配布版の CSP は http を通さないので、設定としても受け付けない
        if !cfg!(debug_assertions) {
            return false;
        }
        let host = host_port.split(':').next().unwrap_or("");
        return host == "localhost" || host == "127.0.0.1";
    }
    true
}

impl EnvConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !is_valid_env_key(&self.env_key) {
            return Err("invalid env key".into());
        }
        if !is_valid_server_origin(&self.server_url) {
            return Err("invalid server url".into());
        }
        if self.device_id.is_empty() || self.device_id.len() > 128 {
            return Err("invalid device id".into());
        }
        Ok(())
    }
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            format: 1,
            shortcut: DEFAULT_SHORTCUT.to_string(),
            notifications_enabled: true,
            active: None,
            known: Vec::new(),
        }
    }
}

impl DesktopSettings {
    pub fn set_active(&mut self, env: Option<EnvConfig>) {
        if let Some(e) = &env {
            self.known.retain(|k| k.env_key != e.env_key);
            self.known.push(e.clone());
        }
        self.active = env;
    }
}

pub fn settings_path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// 読み込み。壊れていた場合は既定値を返し、元ファイルは .broken として退避する（消さない）。
pub fn load(dir: &Path) -> DesktopSettings {
    let path = settings_path(dir);
    match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<DesktopSettings>(&text) {
            Ok(mut s) => {
                if s.shortcut == LEGACY_DEFAULT_SHORTCUT {
                    s.shortcut = DEFAULT_SHORTCUT.to_string();
                }
                s
            }
            Err(_) => {
                let _ = fs::rename(&path, dir.join(format!("{FILE_NAME}.broken")));
                DesktopSettings::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => DesktopSettings::default(),
        // UTF-8 でない等で読めない場合も、次の保存で上書きされないよう退避する
        Err(_) => {
            let _ = fs::rename(&path, dir.join(format!("{FILE_NAME}.broken")));
            DesktopSettings::default()
        }
    }
}

/// 一時ファイルに書いてから rename（書き込み途中のクラッシュで設定を失わない）。
pub fn save(dir: &Path, s: &DesktopSettings) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{FILE_NAME}.tmp"));
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, settings_path(dir)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cuenu-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn roundtrip_and_defaults() {
        let d = tmpdir("rt");
        assert_eq!(load(&d), DesktopSettings::default());
        let mut s = DesktopSettings::default();
        s.shortcut = "Super+Shift+M".into();
        s.set_active(Some(EnvConfig {
            server_url: "https://a.example".into(),
            env_key: "env-a".into(),
            device_id: "d1".into(),
        }));
        save(&d, &s).unwrap();
        assert_eq!(load(&d), s);
    }

    #[test]
    fn legacy_default_shortcut_is_migrated() {
        let d = tmpdir("legacy");
        fs::create_dir_all(&d).unwrap();
        fs::write(settings_path(&d), r#"{"shortcut":"Control+Alt+Space"}"#).unwrap();
        assert_eq!(load(&d).shortcut, DEFAULT_SHORTCUT);
        fs::write(settings_path(&d), r#"{"shortcut":"Super+Shift+K"}"#).unwrap();
        assert_eq!(load(&d).shortcut, "Super+Shift+K");
    }

    #[test]
    fn broken_file_is_kept_aside() {
        let d = tmpdir("broken");
        fs::create_dir_all(&d).unwrap();
        fs::write(settings_path(&d), "{not json").unwrap();
        assert_eq!(load(&d), DesktopSettings::default());
        assert!(d.join(format!("{FILE_NAME}.broken")).exists());
    }

    #[test]
    fn missing_fields_use_defaults() {
        let d = tmpdir("partial");
        fs::create_dir_all(&d).unwrap();
        fs::write(settings_path(&d), r#"{"notificationsEnabled":false}"#).unwrap();
        let s = load(&d);
        assert!(!s.notifications_enabled);
        assert_eq!(s.shortcut, DEFAULT_SHORTCUT);
    }

    #[test]
    fn unreadable_file_is_kept_aside() {
        let d = tmpdir("unreadable");
        fs::create_dir_all(&d).unwrap();
        fs::write(settings_path(&d), [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(load(&d), DesktopSettings::default());
        assert!(d.join(format!("{FILE_NAME}.broken")).exists());
    }

    #[test]
    fn env_config_validation() {
        let ok = EnvConfig { server_url: "https://a.example".into(), env_key: "env-0123abcd".into(), device_id: "d1".into() };
        assert!(ok.validate().is_ok());
        for url in ["http://localhost:8787", "http://127.0.0.1:8787", "https://a.example:8443"] {
            assert!(EnvConfig { server_url: url.into(), ..ok.clone() }.validate().is_ok(), "{url}");
        }
        for url in ["http://a.example", "javascript:alert(1)", "https://", "https://a.example/path", "https://u@a.example", "file:///etc/passwd", "http://localhost.evil.example"] {
            assert!(EnvConfig { server_url: url.into(), ..ok.clone() }.validate().is_err(), "{url}");
        }
        assert!(EnvConfig { env_key: "../x".into(), ..ok.clone() }.validate().is_err());
        assert!(EnvConfig { device_id: String::new(), ..ok }.validate().is_err());
    }

    #[test]
    fn known_envs_are_deduplicated() {
        let mut s = DesktopSettings::default();
        let e = EnvConfig { server_url: "u".into(), env_key: "k".into(), device_id: "d".into() };
        s.set_active(Some(e.clone()));
        s.set_active(Some(EnvConfig { device_id: "d2".into(), ..e }));
        assert_eq!(s.known.len(), 1);
        assert_eq!(s.known[0].device_id, "d2");
    }
}
