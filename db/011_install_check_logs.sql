-- v1.17.63: 安裝/升級 self-check 上傳的紀錄
-- 每次 install.sh / install.ps1 / interactive-upgrade.* 跑完都會 POST 一筆，
-- 用來追蹤每個使用者的安裝健康度（特別是 silent fail 案例如 Bob 的 Task Scheduler 沒註冊）。

CREATE TABLE IF NOT EXISTS install_check_logs (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client_version  TEXT,
  platform        TEXT,
  -- 注意：欄位名不能叫 "trigger"（PostgreSQL 保留字，被某些 ORM / pg \d 解析會壞）
  trigger_kind    TEXT,
  machine         TEXT,
  summary         JSONB,
  full_log        JSONB
);

CREATE INDEX IF NOT EXISTS idx_install_check_logs_user_ts
  ON install_check_logs (user_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_install_check_logs_ts
  ON install_check_logs (ts DESC);
