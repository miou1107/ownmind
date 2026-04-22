-- OwnMind Database Migration
-- Migration: 007_token_usage
-- Description: Token usage tracking — 7 tables for P1 (model_pricing, token_events,
--              token_usage_daily, collector_heartbeat, session_count,
--              usage_tracking_exemption, usage_audit_log) + initial pricing rows.
-- Spec: docs/superpowers/specs/2026-04-21-token-usage-tracking-design.md

-- ============================================================
-- 1. model_pricing — model 定價（支援歷史價格）
-- ============================================================
CREATE TABLE IF NOT EXISTS model_pricing (
    id                  SERIAL PRIMARY KEY,
    tool                VARCHAR(32) NOT NULL,
    model               VARCHAR(128) NOT NULL,
    input_per_1m        NUMERIC(10,4),
    output_per_1m       NUMERIC(10,4),
    cache_write_per_1m  NUMERIC(10,4),
    cache_read_per_1m   NUMERIC(10,4),
    effective_date      DATE NOT NULL,
    notes               TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_model_pricing
    ON model_pricing (tool, model, effective_date);

-- ============================================================
-- 2. token_events — append-only raw events
--    Client 只負責轉發這張表的資料，不做任何 aggregation
--    message_id NOT NULL 確保 UNIQUE dedupe 正確（NULL 不觸發 UNIQUE 衝突）
--    cumulative_total_tokens NOT NULL（D7 單調成長檢查依據）
-- ============================================================
CREATE TABLE IF NOT EXISTS token_events (
    id                          BIGSERIAL PRIMARY KEY,
    user_id                     INT NOT NULL REFERENCES users(id),
    tool                        VARCHAR(32) NOT NULL,
    session_id                  VARCHAR(128) NOT NULL,
    message_id                  VARCHAR(128) NOT NULL,
    model                       VARCHAR(128),
    ts                          TIMESTAMPTZ NOT NULL,
    input_tokens                INT DEFAULT 0,
    output_tokens               INT DEFAULT 0,
    cache_creation_tokens       INT DEFAULT 0,
    cache_read_tokens           INT DEFAULT 0,
    reasoning_tokens            INT DEFAULT 0,
    native_cost_usd             NUMERIC(10,6),
    source_file                 VARCHAR(512),
    cumulative_total_tokens     BIGINT NOT NULL,
    codex_fingerprint_material  JSONB,
    ingested_at                 TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, tool, session_id, message_id)
);
CREATE INDEX IF NOT EXISTS ix_token_events_user_day
    ON token_events (user_id, ts);
CREATE INDEX IF NOT EXISTS ix_token_events_session
    ON token_events (tool, session_id);

-- ============================================================
-- 3. token_usage_daily — server 重算的每日聚合
-- ============================================================
CREATE TABLE IF NOT EXISTS token_usage_daily (
    id                          SERIAL PRIMARY KEY,
    user_id                     INT NOT NULL REFERENCES users(id),
    tool                        VARCHAR(32) NOT NULL,
    session_id                  VARCHAR(128) NOT NULL,
    date                        DATE NOT NULL,
    model                       VARCHAR(128),
    input_tokens                BIGINT,
    output_tokens               BIGINT,
    cache_creation_tokens       BIGINT,
    cache_read_tokens           BIGINT,
    reasoning_tokens            BIGINT,
    message_count               INT,
    cost_usd                    NUMERIC(10,6),
    wall_seconds                INT,
    active_seconds              INT,
    first_ts                    TIMESTAMPTZ,
    last_ts                     TIMESTAMPTZ,
    recomputed_at               TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, tool, session_id, date)
);
CREATE INDEX IF NOT EXISTS ix_tud_user_date
    ON token_usage_daily (user_id, date DESC);

-- ============================================================
-- 4. collector_heartbeat — 回報狀態
-- ============================================================
CREATE TABLE IF NOT EXISTS collector_heartbeat (
    id                  SERIAL PRIMARY KEY,
    user_id             INT NOT NULL REFERENCES users(id),
    tool                VARCHAR(32) NOT NULL,
    last_reported_at    TIMESTAMPTZ NOT NULL,
    last_event_ts       TIMESTAMPTZ,
    scanner_version     VARCHAR(32),
    machine             VARCHAR(128),
    status              VARCHAR(16) DEFAULT 'active',
    UNIQUE (user_id, tool)
);

-- ============================================================
-- 5. session_count — Tier 2 IDE（Cursor / Antigravity）
-- ============================================================
CREATE TABLE IF NOT EXISTS session_count (
    id              SERIAL PRIMARY KEY,
    user_id         INT NOT NULL REFERENCES users(id),
    tool            VARCHAR(32) NOT NULL,
    date            DATE NOT NULL,
    count           INT DEFAULT 1,
    wall_seconds    INT DEFAULT 0,
    UNIQUE (user_id, tool, date)
);

-- ============================================================
-- 6. usage_tracking_exemption — 豁免（super_admin 管理）
-- ============================================================
CREATE TABLE IF NOT EXISTS usage_tracking_exemption (
    user_id     INT PRIMARY KEY REFERENCES users(id),
    granted_by  INT REFERENCES users(id),
    reason      TEXT,
    granted_at  TIMESTAMPTZ DEFAULT NOW(),
    expires_at  TIMESTAMPTZ
);

-- ============================================================
-- 7. usage_audit_log — 異常 ingestion 稽核
--    event_type: unknown_model, token_regression, fingerprint_collision,
--                fingerprint_mismatch, codex_missing_material,
--                ingestion_suppressed_exempt, rate_anomaly ...
-- ============================================================
CREATE TABLE IF NOT EXISTS usage_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INT NOT NULL,
    tool        VARCHAR(32),
    event_type  VARCHAR(32),
    details     JSONB,
    ts          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_audit_user
    ON usage_audit_log (user_id, ts DESC);

-- ============================================================
-- 初始定價（effective_date 設為 2024-01-01 以涵蓋歷史資料）
-- 單位：USD per 1M tokens
-- 以 ON CONFLICT DO NOTHING 保證 migration 冪等
-- ============================================================

-- claude-code: Anthropic pricing（官方 2025 參考價）
INSERT INTO model_pricing
    (tool, model, input_per_1m, output_per_1m, cache_write_per_1m, cache_read_per_1m, effective_date, notes)
VALUES
    ('claude-code', 'claude-opus-4',     15.0000, 75.0000, 18.7500, 1.5000, '2024-01-01', 'Anthropic Opus tier'),
    ('claude-code', 'claude-opus-4-5',   15.0000, 75.0000, 18.7500, 1.5000, '2024-01-01', 'Anthropic Opus tier'),
    ('claude-code', 'claude-opus-4-6',   15.0000, 75.0000, 18.7500, 1.5000, '2024-01-01', 'Anthropic Opus tier'),
    ('claude-code', 'claude-opus-4-7',   15.0000, 75.0000, 18.7500, 1.5000, '2024-01-01', 'Anthropic Opus tier'),
    ('claude-code', 'claude-sonnet-4',    3.0000, 15.0000,  3.7500, 0.3000, '2024-01-01', 'Anthropic Sonnet tier'),
    ('claude-code', 'claude-sonnet-4-5',  3.0000, 15.0000,  3.7500, 0.3000, '2024-01-01', 'Anthropic Sonnet tier'),
    ('claude-code', 'claude-sonnet-4-6',  3.0000, 15.0000,  3.7500, 0.3000, '2024-01-01', 'Anthropic Sonnet tier'),
    ('claude-code', 'claude-haiku-4',     1.0000,  5.0000,  1.2500, 0.1000, '2024-01-01', 'Anthropic Haiku tier'),
    ('claude-code', 'claude-haiku-4-5',   1.0000,  5.0000,  1.2500, 0.1000, '2024-01-01', 'Anthropic Haiku tier')
ON CONFLICT (tool, model, effective_date) DO NOTHING;

-- codex: OpenAI GPT-5 series（placeholder 價格，super_admin 可於 dashboard 更新）
INSERT INTO model_pricing
    (tool, model, input_per_1m, output_per_1m, cache_write_per_1m, cache_read_per_1m, effective_date, notes)
VALUES
    ('codex', 'gpt-5',       10.0000, 30.0000, 12.5000, 1.0000, '2024-01-01', 'Placeholder — 待確認 OpenAI 官價'),
    ('codex', 'gpt-5-mini',   0.5000,  2.0000,  0.6250, 0.0500, '2024-01-01', 'Placeholder — 待確認 OpenAI 官價')
ON CONFLICT (tool, model, effective_date) DO NOTHING;
