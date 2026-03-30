-- Activity Logs: 記錄所有 OwnMind 活動事件（從本機上傳到 server）
CREATE TABLE IF NOT EXISTS activity_logs (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id),
  ts         TIMESTAMPTZ NOT NULL,
  event      VARCHAR(50) NOT NULL,
  tool       VARCHAR(50),
  source     VARCHAR(10),
  details    JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_user_event ON activity_logs (user_id, event);
CREATE INDEX IF NOT EXISTS idx_activity_logs_ts ON activity_logs (ts);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_ts ON activity_logs (user_id, ts);
