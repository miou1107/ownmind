-- db/021_install_check_alert_state.sql
-- v1.26.87: which install-check failures have already been announced.
--
-- A failure is identified by (user_id, machine, check_name) — not by report.
-- One upgrade uploads several reports (install_started / post_install /
-- upgrade_complete), so keying on the report would announce one problem three
-- times.

CREATE TABLE IF NOT EXISTS install_check_alert_state (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine       TEXT        NOT NULL,
  check_name    TEXT        NOT NULL,
  detail        TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  announced_at  TIMESTAMPTZ,
  resolved_at   TIMESTAMPTZ,
  UNIQUE (user_id, machine, check_name)
);

CREATE INDEX IF NOT EXISTS idx_install_check_alert_state_open
  ON install_check_alert_state (user_id, machine)
  WHERE resolved_at IS NULL;
