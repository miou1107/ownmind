-- Console logins get their own credential, which expires and can be revoked.
--
-- Until now POST /api/me/login answered a correct password with the account's api_key — the
-- permanent credential the MCP and every hook hold, which never expires and is only replaced
-- by an explicit rotation — and the console kept it in localStorage. Any script that ran in
-- the console's page could read it, and the console ran with its content security policy
-- switched off. Security review 2026-10-03, item 12.
--
-- A row here is one browser's login. Only a SHA-256 of the token is stored: the table is a
-- list of who is logged in where, and a database dump should not be a stack of live logins.
-- `last_seen_at` drives the idle timeout, `expires_at` the absolute one; both are enforced
-- in src/utils/web-session.js. `revoked_at` is logout, a password change, or an admin reset.
CREATE TABLE IF NOT EXISTS web_sessions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   CHAR(64) NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  user_agent   TEXT
);

-- Revoking every login of one account (password change, admin reset) must not scan the table.
CREATE INDEX IF NOT EXISTS idx_web_sessions_user_active
  ON web_sessions (user_id)
  WHERE revoked_at IS NULL;
