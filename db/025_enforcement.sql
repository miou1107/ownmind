-- Migration 025: standard enforcement.
--
-- Two things: a per-account switch, and the record every check writes.
--
-- The switch lives on the account rather than on the machine. The owner works from several
-- machines and several AI tools, and a per-machine flag leaves whichever machine nobody
-- remembered to configure unprotected. It also makes widening the rollout to the team an
-- UPDATE rather than a release.
--
-- Default 'off' is what makes the client half safe to ship to everybody at once: the server
-- returns before it reaches the model, so accounts outside the pilot pay no latency and no
-- tokens.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS enforcement_mode VARCHAR(10) NOT NULL DEFAULT 'off';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_enforcement_mode_check;
ALTER TABLE users ADD CONSTRAINT users_enforcement_mode_check
  CHECK (enforcement_mode IN ('off', 'check'));

-- One row per check attempt.
--
-- `outcome` keeps 'skipped' and 'failed' apart from 'clean' on purpose. A check that never
-- ran and a check that ran and found nothing are the same shape to a naive schema, and
-- collapsing them makes the "did not run" rate unmeasurable — which is the precise way a
-- broken guard comes to look like a working one.
--
-- `rules_considered` is stored even when the verdict is clean, because "the rule was never
-- selected" and "the rule was selected and the judge got it wrong" need different fixes and
-- cannot be told apart afterwards without it.
CREATE TABLE IF NOT EXISTS compliance_checks (
    id                SERIAL PRIMARY KEY,
    user_id           INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id        VARCHAR(128) NOT NULL,
    turn_index        INT,
    rules_considered  JSONB NOT NULL DEFAULT '[]',
    verdicts          JSONB NOT NULL DEFAULT '[]',
    latency_ms        INT,
    outcome           VARCHAR(20) NOT NULL,
    user_feedback     VARCHAR(20),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE compliance_checks DROP CONSTRAINT IF EXISTS compliance_checks_outcome_check;
ALTER TABLE compliance_checks ADD CONSTRAINT compliance_checks_outcome_check
  CHECK (outcome IN ('clean', 'violation', 'skipped', 'failed'));

ALTER TABLE compliance_checks DROP CONSTRAINT IF EXISTS compliance_checks_feedback_check;
ALTER TABLE compliance_checks ADD CONSTRAINT compliance_checks_feedback_check
  CHECK (user_feedback IS NULL OR user_feedback IN ('correct', 'false_positive'));

CREATE INDEX IF NOT EXISTS idx_compliance_checks_user_created
  ON compliance_checks (user_id, created_at DESC);
