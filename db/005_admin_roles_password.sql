-- Migration 005: Admin roles & password support
-- 1. password_hash 欄位
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- 2. 擴展 role CHECK（支援 super_admin）
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'admin', 'user'));

-- 3. Vin 自動升級為 super_admin
UPDATE users SET role = 'super_admin' WHERE id = 1;

-- 4. 稽核追蹤欄位
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_by INT REFERENCES users(id);

-- 5. 操作稽核表
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  actor_id INT REFERENCES users(id),
  action VARCHAR(50) NOT NULL,
  target_type VARCHAR(50),
  target_id INT,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
