-- 端末トークンをログイン時の OWNER_PASSWORD に結び付ける（パスワード変更で全端末を失効させる）
-- pw_fp = HMAC-SHA256(key = OWNER_PASSWORD, "cuenu-device-binding-v1") の hex。NULL は移行前の端末（次の認証時に現在の値を記録）
ALTER TABLE devices ADD COLUMN pw_fp TEXT;
