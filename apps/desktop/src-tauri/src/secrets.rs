//! 端末トークンを macOS Keychain（ログインキーチェーンの汎用パスワード）に保存する。
//! service = "Cuenu"、account = "device-token:<env_key>"。
//! JS へはトークンを返す必要がある時（同期開始時）だけ `secret_get_token` で渡す。

use keyring::Entry;

const SERVICE: &str = "Cuenu";

fn entry(env_key: &str) -> Result<Entry, String> {
    if !crate::settings::is_valid_env_key(env_key) {
        return Err("invalid env key".into());
    }
    Entry::new(SERVICE, &format!("device-token:{env_key}")).map_err(|e| e.to_string())
}

pub fn set_token(env_key: &str, token: &str) -> Result<(), String> {
    entry(env_key)?.set_password(token).map_err(|e| e.to_string())
}

pub fn get_token(env_key: &str) -> Result<Option<String>, String> {
    match entry(env_key)?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn delete_token(env_key: &str) -> Result<(), String> {
    match entry(env_key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
