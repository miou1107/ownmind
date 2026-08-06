-- v1.26.78 — activity_logs.source was VARCHAR(10) and the values written to it are longer.
--
-- Found in the production log on 2026-08-06:
--   value too long for type character varying(10)
--
-- mcp/ownmind-log.js lifts details.source into this column, so an auto-detected compliance
-- event arrives as 'system_auto' (11). The server writes 'system_server_auto' (18) for its
-- own observed_trigger rows. Neither has ever been stored: across 31,000 rows this column
-- has only ever held 'mcp', 'hook', 'api' and 'e2e-test'.
--
-- The cost is not the missing row. POST /api/activity/batch inserted inside a single try
-- around the whole loop, so one over-long value rejected the entire batch with a 500 and
-- every event in it was lost.
--
-- Widened rather than shortening the strings, because installed clients send them too and
-- some of those will not be upgraded soon (v1.26.29 is still in the field). Shortening the
-- server's literals would leave every one of those clients still failing.
--
-- 64 rather than the 24 the longest current value needs: sizing a column to today's
-- longest string is the same defect waiting for tomorrow's.
--
-- Widening a varchar is a catalog-only change in Postgres. It takes an ACCESS EXCLUSIVE
-- lock but rewrites no rows and returns immediately, so it is safe on this table's size
-- (31k rows) and on much larger ones.

BEGIN;

ALTER TABLE activity_logs
  ALTER COLUMN source TYPE VARCHAR(64);

COMMENT ON COLUMN activity_logs.source IS
  'Where the event came from: mcp | hook | api | system_auto | system_server_auto | '
  'session_audit | post_commit | … Widened from VARCHAR(10) in v1.26.78; the shorter '
  'column silently rejected whole batches rather than single rows.';

COMMIT;
