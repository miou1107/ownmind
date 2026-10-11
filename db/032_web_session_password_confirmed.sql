-- v1.32.10 — typing the password again counts as a fresh login.
--
-- Copying a key or an install prompt from the console needs a login from the last 15
-- minutes. Until now the only way back was logging out and in again. POST
-- /api/me/confirm-password stamps this column instead, and the recent-login check takes
-- whichever is later, this or created_at. NULL means the password was never re-typed.

ALTER TABLE web_sessions
  ADD COLUMN IF NOT EXISTS password_confirmed_at TIMESTAMPTZ;
