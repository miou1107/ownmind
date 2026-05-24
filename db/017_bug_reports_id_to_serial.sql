-- v1.19.15: bug_reports 系列五張表 id 從 BIGSERIAL 改 SERIAL
--
-- 為什麼：
--   v1.19.14 部署後 smoke test 發現 POST /api/bug-reports 回應的 id
--   是字串 "1" 而非數字 1、跟既有 memories 表（SERIAL、回數字）不一致。
--   差別在 BIGSERIAL（PostgreSQL 型別 oid 20）：node-pg 套件預設把
--   bigint 回字串、避免超過 JS Number 安全整數上限失精；SERIAL
--   （oid 23）則自動轉成 Number。
--
--   bug_reports 表用 SERIAL（21 億上限）絕對夠用（一天 1 萬筆要燒 575
--   年）、改 schema 比改 type parser 風險小（不影響既有 token_usage
--   的 BIGINT 計數欄位）。
--
-- 對應規格：openspec/changes/v1.19.15-bug-reports-id-serial/proposal.md
--
-- 安全性：
--   - 開頭 sanity check：五張表任一非空 → RAISE EXCEPTION 拒絕跑
--     （避免在 prod 已有資料時毀資料）
--   - PostgreSQL 不能直接 ALTER BIGSERIAL → SERIAL（sequence 型別綁死）
--     、選 DROP + CREATE 重建（表已知空、無資料風險）
--   - 跑完後表結構跟 016 一模一樣、只差 id 型別

-- ============================================================
-- 0. Sanity check：表必須是空的才能跑
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM bug_reports LIMIT 1)
     OR EXISTS (SELECT 1 FROM bug_report_declines LIMIT 1)
     OR EXISTS (SELECT 1 FROM bug_report_spam_suspects LIMIT 1)
     OR EXISTS (SELECT 1 FROM bug_report_spam_blocks LIMIT 1)
     OR EXISTS (SELECT 1 FROM bug_report_notification_mutes LIMIT 1) THEN
    RAISE EXCEPTION 'bug_reports 系列表已有資料、不能用此 migration 改 id 型別。請先匯出資料、再手動跑 DROP + CREATE + 匯入流程';
  END IF;
END $$;

-- ============================================================
-- 1. DROP（CASCADE 連同 constraint / index 一起清）
-- ============================================================
DROP TABLE IF EXISTS bug_report_notification_mutes CASCADE;
DROP TABLE IF EXISTS bug_report_spam_blocks CASCADE;
DROP TABLE IF EXISTS bug_report_spam_suspects CASCADE;
DROP TABLE IF EXISTS bug_report_declines CASCADE;
DROP TABLE IF EXISTS bug_reports CASCADE;

-- ============================================================
-- 2. 重建 bug_reports（id 改 SERIAL）
-- ============================================================
CREATE TABLE bug_reports (
    id                    SERIAL PRIMARY KEY,
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
    notified_to_reporter  BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT bug_reports_severity_check
      CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    CONSTRAINT bug_reports_status_check
      CHECK (status IN ('new', 'triaged', 'in_progress', 'fixed', 'wontfix')),
    CONSTRAINT bug_reports_status_reason_check
      CHECK (status_reason IS NULL OR status_reason IN (
        'by_design', 'duplicate', 'low_priority', 'cannot_reproduce', 'wontfix_other'
      ))
);

CREATE INDEX idx_bug_reports_user_created
  ON bug_reports(user_id, created_at DESC);
CREATE INDEX idx_bug_reports_status_created
  ON bug_reports(status, created_at DESC);
CREATE INDEX idx_bug_reports_fingerprint
  ON bug_reports(bug_fingerprint);
CREATE INDEX idx_bug_reports_user_fingerprint_created
  ON bug_reports(user_id, bug_fingerprint, created_at DESC);

-- ============================================================
-- 3. 重建 bug_report_declines（id 改 SERIAL）
-- ============================================================
CREATE TABLE bug_report_declines (
    id                SERIAL PRIMARY KEY,
    user_id           INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_fingerprint VARCHAR(64),
    bug_fingerprint   VARCHAR(64) NOT NULL,
    declined_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bug_report_declines_lookup
  ON bug_report_declines(user_id, bug_fingerprint, declined_at DESC);

-- ============================================================
-- 4. 重建 bug_report_spam_suspects（id 改 SERIAL、report_ids 改 INT[]）
-- ============================================================
CREATE TABLE bug_report_spam_suspects (
    id            SERIAL PRIMARY KEY,
    user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    triggered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    trigger_rule  VARCHAR(32) NOT NULL,
    report_ids    INT[] NOT NULL,
    status        VARCHAR(16) NOT NULL DEFAULT 'pending',
    reviewed_by   INT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at   TIMESTAMPTZ,
    CONSTRAINT bug_report_spam_suspects_trigger_rule_check
      CHECK (trigger_rule IN (
        'high_volume_1h', 'high_volume_24h', 'repeated_fingerprint', 'similar_content'
      )),
    CONSTRAINT bug_report_spam_suspects_status_check
      CHECK (status IN ('pending', 'confirmed_spam', 'dismissed'))
);

CREATE INDEX idx_bug_report_spam_suspects_status_triggered
  ON bug_report_spam_suspects(status, triggered_at DESC);

-- ============================================================
-- 5. 重建 bug_report_spam_blocks（id 改 SERIAL）
-- ============================================================
CREATE TABLE bug_report_spam_blocks (
    id             SERIAL PRIMARY KEY,
    user_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    blocked_until  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
    reason         TEXT,
    blocked_by     INT NOT NULL REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_bug_report_spam_blocks_active
  ON bug_report_spam_blocks(user_id, blocked_until DESC);

-- ============================================================
-- 6. 重建 bug_report_notification_mutes（id 改 SERIAL）
-- ============================================================
CREATE TABLE bug_report_notification_mutes (
    id           SERIAL PRIMARY KEY,
    user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mute_target  VARCHAR(32) NOT NULL,
    target_value VARCHAR(64),
    muted_until  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
    CONSTRAINT bug_report_notification_mutes_target_check
      CHECK (mute_target IN ('fingerprint', 'own_reports')),
    CONSTRAINT bug_report_notification_mutes_target_value_check
      CHECK (
        (mute_target = 'fingerprint' AND target_value IS NOT NULL)
        OR
        (mute_target = 'own_reports' AND target_value IS NULL)
      )
);

CREATE INDEX idx_bug_report_notification_mutes_lookup
  ON bug_report_notification_mutes(user_id, mute_target, muted_until DESC);

-- ============================================================
-- Sanity check SQL（手動跑、確認 migration 成功）
-- ============================================================
--
-- 1. 確認所有表的 id 是 integer（不是 bigint）：
--    SELECT table_name, column_name, data_type FROM information_schema.columns
--     WHERE table_name LIKE 'bug_report%' AND column_name = 'id'
--     ORDER BY table_name;
--    → 預期：data_type 都是 'integer'、不是 'bigint'
--
-- 2. 確認 report_ids 是 integer[]：
--    SELECT column_name, data_type, udt_name FROM information_schema.columns
--     WHERE table_name = 'bug_report_spam_suspects' AND column_name = 'report_ids';
--    → 預期：udt_name = '_int4'（int array）、不是 '_int8'
--
-- 3. POST /api/bug-reports 建一筆 → 回應 id 應是數字 1、不是字串 "1"
