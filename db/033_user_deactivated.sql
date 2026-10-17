-- v1.32.13 — an account can be turned off without being deleted.
--
-- 2026-10-11: a colleague left. Deleting the account takes every memory with it; leaving
-- it kept a working key and kept the person in every team count. A row with
-- deactivated_at set cannot authenticate, and team rosters leave it out. NULL = active.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deactivated_by INT REFERENCES users(id);
