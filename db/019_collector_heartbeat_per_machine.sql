-- 019: one collector_heartbeat row per machine, not per person.
--
-- The table was UNIQUE (user_id, tool), so a person with two computers had exactly five
-- slots however many machines they owned, and every scan overwrote the last machine's
-- `machine`, `scanner_version`, `os` and `reason`.
--
-- Watched happen on production 2026-08-05. At 11:50 one member's rows read `claude-code`
-- on TANK and the other four on Vincent.local. After a manual scan on the Windows box at
-- 12:30 all five read TANK, and the Mac's status was gone from the database with no
-- record it had ever reported.
--
-- The cost is not cosmetic: **a dead collector on one machine is invisible while another
-- machine of the same person is alive**, because the heartbeat is fresh and the usage is
-- flowing. It is also the reason v1.26.72's self-check could only answer "the server
-- records this against another computer" instead of answering the question asked.
--
-- Blast radius when this was written: nine machine names mapped one-to-one onto nine
-- users except for one person. It grows the moment anybody else runs a laptop and a
-- desktop.

BEGIN;

-- 1. `machine` has to be definite before it can be part of the key. Postgres treats
--    NULLs as distinct in a unique index, so a NULL machine would insert a brand new
--    row on every heartbeat rather than conflicting with the previous one.
--
--    'unknown' rather than '' so it reads as a value in the console instead of a blank
--    cell somebody has to interpret. Any client old enough to send no machine is old
--    enough that "which computer" genuinely is unknown.
UPDATE collector_heartbeat SET machine = 'unknown' WHERE machine IS NULL;

ALTER TABLE collector_heartbeat ALTER COLUMN machine SET DEFAULT 'unknown';
ALTER TABLE collector_heartbeat ALTER COLUMN machine SET NOT NULL;

-- 2. Swap the uniqueness, **new index first**.
--
--    Existing rows cannot collide: they are already unique on (user_id, tool) and are
--    therefore unique on (user_id, tool, machine) as well, whatever the backfill above
--    wrote. Building the new index while the old constraint is still in force is what
--    turns that from a claim into a check — if duplicates somehow exist, this fails and
--    the whole transaction rolls back rather than leaving the table with no uniqueness
--    at all.
--
--    Not CONCURRENTLY. It cannot run inside a transaction, it leaves an INVALID index
--    behind on failure, and the lock it avoids is not worth avoiding here: this table
--    holds one row per (person, tool) — 45 of them on the server this was written for —
--    so the index build is instantaneous. On a table large enough for the ShareLock to
--    matter, this migration would need rewriting.
CREATE UNIQUE INDEX IF NOT EXISTS collector_heartbeat_user_tool_machine_key
  ON collector_heartbeat (user_id, tool, machine);

ALTER TABLE collector_heartbeat
  DROP CONSTRAINT IF EXISTS collector_heartbeat_user_id_tool_key;

COMMENT ON COLUMN collector_heartbeat.machine IS
  'Hostname the collector reported from. Part of the row identity since v1.26.73: one '
  'row per (user, tool, machine), so a person with two computers no longer has them '
  'overwriting each other. "unknown" for clients too old to report it.';

COMMIT;
