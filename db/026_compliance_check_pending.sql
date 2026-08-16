-- A reply check that has been opened but not yet judged.
--
-- The judge is moving off the llm switch and onto the user's own Claude Code subscription
-- at the owner's standing instruction. That model lives on the user's machine, so the check
-- stops being one round trip:
-- the server selects the rules and opens a row, the client judges, and the verdict comes back
-- afterwards — usually within the same turn, sometimes the next one.
--
-- `pending` is the state in between, and it has to be a real one. Leaving the row's outcome
-- as 'skipped' until the verdict lands would count a check that is still running as a check
-- that found nothing, which is the same class of lie as the green tick this project spent
-- v1.30.9 removing from the pre-commit hook.
--
-- Rows can legitimately stay `pending` forever — a machine that goes off before its judge
-- finishes leaves one behind. That is a fact worth being able to count, not an error: the
-- ratio of pending to resolved is how anyone will know whether the new path actually returns.
ALTER TABLE compliance_checks DROP CONSTRAINT IF EXISTS compliance_checks_outcome_check;
ALTER TABLE compliance_checks ADD CONSTRAINT compliance_checks_outcome_check
  CHECK (outcome IN ('clean', 'violation', 'skipped', 'failed', 'pending'));

-- Finding the rows still waiting has to stay cheap: the client asks about its own session's
-- outstanding checks on every turn, and a sequential scan over the whole history would grow
-- into the per-turn cost this change exists to remove.
CREATE INDEX IF NOT EXISTS idx_compliance_checks_pending
  ON compliance_checks (user_id, session_id)
  WHERE outcome = 'pending';
