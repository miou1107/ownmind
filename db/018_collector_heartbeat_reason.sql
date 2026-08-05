-- v1.26.69 — why a collector had nothing to send.
--
-- The console already separates `flowing` from `silent` (v1.26.50). `silent` means the
-- heartbeat arrives and no usage rows do, and it has at least five causes that look
-- identical from here: the sqlite3 CLI is missing, the tool is not installed, the tool
-- is idle, the collector is reading a directory the tool abandoned, or the machine
-- changed account and the cursor still claims the day was reported.
--
-- The collector knows which one applies at the moment it gives up. Until now it wrote
-- that to a local log file and sent the server the literal word 'active'.
--
-- This is a new column rather than a reuse of `status`. `status` is dead here (always
-- 'active', never selected), but the name is already taken one layer up: the admin API
-- computes its own per-client `status` of active/stale/offline/unknown from heartbeat
-- age. Two meanings under one name is how the next person gets it wrong.

ALTER TABLE collector_heartbeat
  ADD COLUMN IF NOT EXISTS reason VARCHAR(32);

COMMENT ON COLUMN collector_heartbeat.reason IS
  'Why this collector had nothing to send: ok | no_new_activity | no_install | '
  'sqlite_missing | unreadable | account_changed. NULL means a collector older than '
  'v1.26.69, which cannot say.';
