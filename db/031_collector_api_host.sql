-- v1.32.0 — which server each machine reports to.
--
-- 2026-10-08, issue #152: two computers were still posting to the retired host kkvin.com
-- a week after the move, and finding them took reading nginx logs on that host and
-- matching a handoff number against everyone's session logs. Every row here said
-- 1.31.14; none said where it connects. Now the scanner's heartbeat carries the host part
-- of the address it posts to, and the admin list flags any row whose host is not the
-- server's own.
--
-- Host only: no scheme, port, path or key. NULL means a scanner older than v1.32.0, or the
-- MCP, which cannot say; a heartbeat without the field leaves the stored value alone.

ALTER TABLE collector_heartbeat
  ADD COLUMN IF NOT EXISTS api_host VARCHAR(255);

COMMENT ON COLUMN collector_heartbeat.api_host IS
  'Host part of the URL this collector posts to (e.g. fapa.welcometw.com). NULL means a '
  'collector older than v1.32.0, which cannot say.';
