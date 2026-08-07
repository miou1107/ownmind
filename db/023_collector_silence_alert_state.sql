-- db/023_collector_silence_alert_state.sql
-- v1.26.99: which machines have already been told their collector went quiet.
--
-- A silence is identified by (user_id, machine) — not by tool. One dead schedule
-- freezes every tool the scanner writes at once, so keying on the tool would
-- announce one broken machine four times.
--
-- `stale_tools` is stored so a machine whose silence widens (a fourth tool joins
-- the three already frozen) updates the record without re-announcing. It holds
-- the tool names joined by a comma, ordered, so the same silence always produces
-- the same string.

CREATE TABLE IF NOT EXISTS collector_silence_alert_state (
  id             BIGSERIAL PRIMARY KEY,
  user_id        INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine        TEXT        NOT NULL,
  stale_tools    TEXT        NOT NULL DEFAULT '',
  last_beat_at   TIMESTAMPTZ,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  announced_at   TIMESTAMPTZ,
  resolved_at    TIMESTAMPTZ,
  -- The broadcast this machine's owner was sent, so fixing the collector can end
  -- it early. The notice is deliberately un-snoozeable and runs for two days;
  -- without this, somebody who repairs their machine within the hour keeps being
  -- told about it in the first sentence of every conversation until it expires.
  -- ON DELETE SET NULL, not CASCADE: an admin deleting the broadcast row must not
  -- take the record of having announced it, or the next sweep announces again.
  broadcast_id   INTEGER REFERENCES broadcast_messages(id) ON DELETE SET NULL,
  UNIQUE (user_id, machine)
);

CREATE INDEX IF NOT EXISTS idx_collector_silence_alert_state_open
  ON collector_silence_alert_state (user_id, machine)
  WHERE resolved_at IS NULL;
