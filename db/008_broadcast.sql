-- OwnMind Database Migration
-- Migration: 008_broadcast
-- Description: Broadcast system (v1.17.0)
--   - broadcast_messages: admin 發的廣播 + 自動升級提醒
--   - user_broadcast_state: user × tool 的 dismiss / snooze / last_injected 狀態
--   - user_tool_last_seen: 首次對話 / 隔 4h 判定用
--   - memories.is_test flag: 升級驗測用的暫存記憶標記（D16）
-- Spec: docs/superpowers/specs/2026-04-22-client-version-broadcast-upgrade-design.md

-- ============================================================
-- 1. broadcast_messages — admin 發 + 系統自動產生
-- ============================================================
CREATE TABLE IF NOT EXISTS broadcast_messages (
    id                SERIAL PRIMARY KEY,
    type              VARCHAR(32) NOT NULL
                      CHECK (type IN ('announcement', 'upgrade_reminder', 'maintenance', 'rule_change')),
    severity          VARCHAR(16) NOT NULL DEFAULT 'info'
                      CHECK (severity IN ('info', 'warning', 'critical')),
    title             VARCHAR(200) NOT NULL,
    body              TEXT NOT NULL,
    cta_text          VARCHAR(100),
    cta_action        VARCHAR(100),
    min_version       VARCHAR(32),
    max_version       VARCHAR(32),
    target_users      INT[],
    allow_snooze      BOOLEAN DEFAULT FALSE,
    snooze_hours      INT DEFAULT 24 CHECK (snooze_hours > 0),
    cooldown_minutes  INT DEFAULT 1440 CHECK (cooldown_minutes >= 0),
    starts_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at           TIMESTAMPTZ,
    created_by        INT NOT NULL REFERENCES users(id),
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    is_auto           BOOLEAN NOT NULL DEFAULT FALSE,
    CHECK (ends_at IS NULL OR ends_at > starts_at),
    -- 自動產生的 upgrade_reminder 必須帶 max_version，否則唯一索引 (type, max_version)
    -- 在 NULL 下會允許無限重複（PostgreSQL NULL 不相等於 NULL）。
    CHECK (
        is_auto = FALSE
        OR type <> 'upgrade_reminder'
        OR max_version IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS ix_broadcast_active_range
    ON broadcast_messages (starts_at, ends_at);

-- 自動升級提醒冪等用：同版本只插一筆
-- 上方 CHECK 已保證 is_auto=TRUE AND type='upgrade_reminder' 時 max_version NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS ux_broadcast_auto_upgrade
    ON broadcast_messages (type, max_version)
    WHERE is_auto = TRUE AND type = 'upgrade_reminder';

-- ============================================================
-- 2. user_broadcast_state — per (user, broadcast, tool)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_broadcast_state (
    id                SERIAL PRIMARY KEY,
    user_id           INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    broadcast_id      INT NOT NULL REFERENCES broadcast_messages(id) ON DELETE CASCADE,
    tool              VARCHAR(32) NOT NULL,
    dismissed_at      TIMESTAMPTZ,
    snooze_until      TIMESTAMPTZ,
    last_injected_at  TIMESTAMPTZ,
    UNIQUE (user_id, broadcast_id, tool)
);

CREATE INDEX IF NOT EXISTS ix_ubs_snooze
    ON user_broadcast_state (user_id, tool, snooze_until)
    WHERE snooze_until IS NOT NULL;

-- ============================================================
-- 3. user_tool_last_seen — 首次 / 隔 4h 判定
-- ============================================================
CREATE TABLE IF NOT EXISTS user_tool_last_seen (
    user_id            INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tool               VARCHAR(32) NOT NULL,
    last_mcp_call_at   TIMESTAMPTZ NOT NULL,
    last_day_seen_tpe  DATE NOT NULL,
    PRIMARY KEY (user_id, tool)
);

CREATE INDEX IF NOT EXISTS ix_utls_last_call
    ON user_tool_last_seen (last_mcp_call_at);

-- ============================================================
-- 4. memories.is_test — 升級驗測暫存記憶（D16）
-- ============================================================
ALTER TABLE memories ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index：大多數 row is_test=FALSE，只 index 少量 TRUE
CREATE INDEX IF NOT EXISTS ix_memories_is_test
    ON memories (user_id, title)
    WHERE is_test = TRUE;
