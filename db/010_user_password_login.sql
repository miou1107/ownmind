-- Migration 010: User password login（v1.17.25）
-- 開放給 user role 用 email + password 登入 /ownmind/me/ 報告頁
-- v1.17.24 是貼 api_key，UX 不友善 + 容易外洩；改成標準帳密流程

-- 1. 強制改密碼旗標：首次登入 / admin 重設後強制改
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE;

-- 2. 預設密碼（Password42760988）的 bcrypt rounds=10 hash
--    取自 Node.js bcrypt.hashSync('Password42760988', 10)
--    實際 hash 由 server boot 時動態檢查並補（見 src/jobs/seed-default-passwords.js），
--    此 SQL 只負責 schema 變更。

-- 3. Index：以 email 查詢登入時用
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));
