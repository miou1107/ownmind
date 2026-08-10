-- 024_usage_audit_unknown_model_once.sql
--
-- v1.26.135. `usage_audit_log` held 253,409 rows on 2026-08-10 and every one of
-- them was `unknown_model`. The allowlist behind that check is `model_pricing`,
-- which stopped being maintained when v1.26.60 removed cost computation, so
-- every message from every model in current use — opus-5, sonnet-5, fable-5,
-- gpt-5.5 — was landing a row. ~6,700 a day. Any real anomaly written to this
-- table would have been invisible underneath it.
--
-- The application now reports a model once and then stays quiet (see
-- src/routes/usage/events.js). This index is the backstop for the race that
-- application-level check cannot close: two uploads carrying the same
-- never-seen model can both read "not reported yet" before either has
-- inserted. Paired with ON CONFLICT DO NOTHING on the insert, the loser is
-- dropped silently instead of raising.
--
-- Partial and expression-based on purpose: only `unknown_model` rows are
-- one-per-model. Other event types (token_regression, fingerprint_mismatch,
-- fingerprint_collision) are per-message by design and must stay unconstrained.

-- Collapse the duplicates FIRST. Production was truncated by hand on
-- 2026-08-10, but a dev database, a second deployment, or anyone restoring
-- usage_audit_log-20260810.sql.gz still holds them — and CREATE UNIQUE INDEX
-- raises on existing duplicates. `IF NOT EXISTS` does not help: it matches on
-- index *name*, so it would not even look. The migration runner throws on
-- failure, the server aborts startup, and the file is only recorded in
-- schema_migrations on success — so without this DELETE the container
-- crash-loops on every restart until somebody runs SQL by hand.
DELETE FROM usage_audit_log a
 USING usage_audit_log b
 WHERE a.event_type = 'unknown_model'
   AND b.event_type = 'unknown_model'
   AND a.tool = b.tool
   AND a.details->>'model' = b.details->>'model'
   AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_audit_unknown_model
  ON usage_audit_log (tool, (details->>'model'))
  WHERE event_type = 'unknown_model';
