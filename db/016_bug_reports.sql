-- v1.19.14: 錯誤回報工具（使用者 ⇄ 開發者雙向通知）
--
-- 為什麼：
--   OwnMind 沒有專門「使用者回報程式錯誤」的管道。現有 ownmind_report_compliance
--   只記鐵律遵守狀況、ownmind_save type=project 又會跟專案待辦語意混雜。
--   倉庫已對外公開、需要正式管道讓使用者主動回報 OwnMind 本身的問題。
--
--   設計經三輪 Gemini 對抗審查（v1 → v4.1）：
--     - 砍掉本地持久化 retry queue（過度設計）
--     - 整合 should-prompt 到原始錯誤回應（後端內聯查冷靜期）
--     - 砍掉客戶端 confirm-window hook（多客戶端做不到）
--     - 改用後台 spam 偵測 + 24h 封鎖當 AI 腦補的第二道防線
--     - 介面層加「同 fingerprint 1h 3 筆直接 429」當第一道防線
--
-- 對應規格：openspec/changes/v1.19.14-bug-report-tool/spec.md
--
-- 安全性：
--   - 所有表都 CREATE IF NOT EXISTS、可 idempotent 重跑
--   - CHECK constraint 確保 enum 欄位只能寫合法值
--   - FK ON DELETE CASCADE（user 砍掉時相關回報也清）
--   - 不動既有資料、純新增表
--
-- 不做：
--   - down migration（沿用既有政策：只向前、失敗停止 server）
--   - trigger 同步歷史紀錄（status 變動寫到主表的 updated_at 就夠）

-- ============================================================
-- 1. bug_reports：主表
-- ============================================================
CREATE TABLE IF NOT EXISTS bug_reports (
    id                    BIGSERIAL PRIMARY KEY,
    user_id               INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_fingerprint    VARCHAR(64) NOT NULL,
    client_tool           VARCHAR(64),
    title                 TEXT NOT NULL,
    description           TEXT NOT NULL,
    severity              VARCHAR(16) NOT NULL DEFAULT 'medium',
    component             VARCHAR(64),
    reproduce_input       TEXT,
    context_blob          JSONB,
    context_blob_size_bytes INT,
    bug_fingerprint       VARCHAR(64) NOT NULL,
    related_lint_event_ids BIGINT[],
    status                VARCHAR(16) NOT NULL DEFAULT 'new',
    status_reason         VARCHAR(32),
    status_reason_note    TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at           TIMESTAMPTZ,
    resolved_by           INT REFERENCES users(id) ON DELETE SET NULL,
    notified_to_reporter  BOOLEAN NOT NULL DEFAULT FALSE
);

-- CHECK constraints（用 DO 包、避免重跑時 constraint 已存在出錯）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bug_reports_severity_check') THEN
    ALTER TABLE bug_reports ADD CONSTRAINT bug_reports_severity_check
      CHECK (severity IN ('low', 'medium', 'high', 'critical'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bug_reports_status_check') THEN
    ALTER TABLE bug_reports ADD CONSTRAINT bug_reports_status_check
      CHECK (status IN ('new', 'triaged', 'in_progress', 'fixed', 'wontfix'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bug_reports_status_reason_check') THEN
    ALTER TABLE bug_reports ADD CONSTRAINT bug_reports_status_reason_check
      CHECK (status_reason IS NULL OR status_reason IN (
        'by_design', 'duplicate', 'low_priority', 'cannot_reproduce', 'wontfix_other'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bug_reports_user_created
  ON bug_reports(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bug_reports_status_created
  ON bug_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bug_reports_fingerprint
  ON bug_reports(bug_fingerprint);
-- 查「該 user 過去 1h 同 fingerprint 幾筆」用、給介面層 429 判斷加速
CREATE INDEX IF NOT EXISTS idx_bug_reports_user_fingerprint_created
  ON bug_reports(user_id, bug_fingerprint, created_at DESC);

-- ============================================================
-- 2. bug_report_declines：冷靜期紀錄
-- ============================================================
CREATE TABLE IF NOT EXISTS bug_report_declines (
    id                BIGSERIAL PRIMARY KEY,
    user_id           INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_fingerprint VARCHAR(64),
    bug_fingerprint   VARCHAR(64) NOT NULL,
    declined_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 給「該 user 過去 24h 對該 fingerprint 是否拒絕過」查詢加速
CREATE INDEX IF NOT EXISTS idx_bug_report_declines_lookup
  ON bug_report_declines(user_id, bug_fingerprint, declined_at DESC);

-- ============================================================
-- 3. bug_report_spam_suspects：spam 偵測結果（待管理員審查）
-- ============================================================
CREATE TABLE IF NOT EXISTS bug_report_spam_suspects (
    id            BIGSERIAL PRIMARY KEY,
    user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    triggered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    trigger_rule  VARCHAR(32) NOT NULL,
    report_ids    BIGINT[] NOT NULL,
    status        VARCHAR(16) NOT NULL DEFAULT 'pending',
    reviewed_by   INT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at   TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bug_report_spam_suspects_trigger_rule_check') THEN
    ALTER TABLE bug_report_spam_suspects ADD CONSTRAINT bug_report_spam_suspects_trigger_rule_check
      CHECK (trigger_rule IN (
        'high_volume_1h', 'high_volume_24h', 'repeated_fingerprint', 'similar_content'
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bug_report_spam_suspects_status_check') THEN
    ALTER TABLE bug_report_spam_suspects ADD CONSTRAINT bug_report_spam_suspects_status_check
      CHECK (status IN ('pending', 'confirmed_spam', 'dismissed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bug_report_spam_suspects_status_triggered
  ON bug_report_spam_suspects(status, triggered_at DESC);

-- ============================================================
-- 4. bug_report_spam_blocks：24h 封鎖期（管理員確認 spam 後）
-- ============================================================
CREATE TABLE IF NOT EXISTS bug_report_spam_blocks (
    id             BIGSERIAL PRIMARY KEY,
    user_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    blocked_until  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
    reason         TEXT,
    blocked_by     INT NOT NULL REFERENCES users(id) ON DELETE SET NULL
);

-- 給「該 user 是否在未過期封鎖期」查詢加速
CREATE INDEX IF NOT EXISTS idx_bug_report_spam_blocks_active
  ON bug_report_spam_blocks(user_id, blocked_until DESC);

-- ============================================================
-- 5. bug_report_notification_mutes：通知靜音
-- ============================================================
CREATE TABLE IF NOT EXISTS bug_report_notification_mutes (
    id           BIGSERIAL PRIMARY KEY,
    user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mute_target  VARCHAR(32) NOT NULL,
    target_value VARCHAR(64),
    muted_until  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days')
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bug_report_notification_mutes_target_check') THEN
    ALTER TABLE bug_report_notification_mutes ADD CONSTRAINT bug_report_notification_mutes_target_check
      CHECK (mute_target IN ('fingerprint', 'own_reports'));
  END IF;

  -- mute_target='fingerprint' 時 target_value 必填
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bug_report_notification_mutes_target_value_check') THEN
    ALTER TABLE bug_report_notification_mutes ADD CONSTRAINT bug_report_notification_mutes_target_value_check
      CHECK (
        (mute_target = 'fingerprint' AND target_value IS NOT NULL)
        OR
        (mute_target = 'own_reports' AND target_value IS NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bug_report_notification_mutes_lookup
  ON bug_report_notification_mutes(user_id, mute_target, muted_until DESC);

-- ============================================================
-- Sanity check SQL（手動跑、確認 migration 成功）
-- ============================================================
--
-- 1. 確認五張表都建好：
--    SELECT tablename FROM pg_tables
--     WHERE tablename LIKE 'bug_report%' ORDER BY tablename;
--    → 預期：bug_report_declines / bug_report_notification_mutes /
--           bug_report_spam_blocks / bug_report_spam_suspects / bug_reports
--
-- 2. 確認所有 CHECK constraint 都建好：
--    SELECT conname FROM pg_constraint
--     WHERE conname LIKE 'bug_report%check' ORDER BY conname;
--    → 預期 6 條 constraint
--
-- 3. 確認所有 index 都建好：
--    SELECT indexname FROM pg_indexes
--     WHERE tablename LIKE 'bug_report%' ORDER BY indexname;
--    → 預期 6 個 idx_ 開頭（PK index 不算）
--
-- 4. 確認 CHECK constraint 真的擋下無效值：
--    INSERT INTO bug_reports (user_id, device_fingerprint, title, description,
--      severity, bug_fingerprint) VALUES (1, 'fp', 't', 'd', 'invalid', 'bf');
--    → 預期：ERROR check constraint bug_reports_severity_check
--    （測完 rollback）
--
-- 5. 確認 blocked_until 預設值正確（+24h）：
--    INSERT INTO bug_report_spam_blocks (user_id, blocked_by) VALUES (1, 1)
--      RETURNING blocked_until - blocked_at;
--    → 預期：1 day 0:00:00
--    （測完 rollback）
--
-- 6. 確認 mute target/value constraint 對應正確：
--    INSERT INTO bug_report_notification_mutes (user_id, mute_target, target_value)
--      VALUES (1, 'fingerprint', NULL);
--    → 預期：ERROR check constraint
--    INSERT INTO bug_report_notification_mutes (user_id, mute_target, target_value)
--      VALUES (1, 'own_reports', 'something');
--    → 預期：ERROR check constraint
--    （測完 rollback）
