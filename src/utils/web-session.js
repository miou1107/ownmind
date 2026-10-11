import crypto from 'node:crypto';

/**
 * Console logins: a credential that expires and can be revoked, instead of the api_key.
 *
 * The console used to log in by receiving the account's api_key and keeping it in
 * localStorage. That key is the one the MCP and every hook hold, it never expires, and
 * anything that ran script in the console's page could read it. Security review 2026-10-03,
 * item 12. A session token here grants the same API access — the console needs all of it —
 * but it ends: after IDLE_MS without use, after ABSOLUTE_MS regardless, on logout, and on a
 * password change or admin reset. Leaking one is a bounded event; leaking the key was not.
 *
 * Tokens carry a fixed prefix so the auth middleware can tell them from api_keys without a
 * second database round trip, and so a token pasted somewhere is recognisable for what it is.
 * Only a SHA-256 of the token is stored.
 */

export const SESSION_PREFIX = 'oms_';
export const IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
/** last_seen_at is refreshed at most this often, so every API call is not also a write. */
export const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
/**
 * How fresh a login must be to turn into the permanent key. Rotating a key or revealing one
 * answers with the api_key itself, so without this a stolen session converts into the very
 * credential sessions exist to keep out of the browser (review of this fix). Callers that
 * hold the api_key already — the MCP, the scripts — are not sessions and are not affected.
 */
export const RECENT_LOGIN_MS = 15 * 60 * 1000;
/** Ended sessions are kept this long for the record, then deleted. */
export const RETAIN_ENDED_MS = 30 * 24 * 60 * 60 * 1000;

export function isSessionToken(value) {
  return typeof value === 'string' && value.startsWith(SESSION_PREFIX);
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * @param {{ query: Function, userId: number, userAgent?: string, now?: number }} args
 * @returns {Promise<string>} the token — returned once, never stored
 */
export async function createSession({ query, userId, userAgent = '', now = Date.now() }) {
  const token = SESSION_PREFIX + crypto.randomBytes(32).toString('base64url');
  // Every login adds a row and nothing else removes one, so logins clear out the long-dead.
  // Best effort: housekeeping must not fail the login it rides on.
  try {
    await query(
      `DELETE FROM web_sessions WHERE expires_at < $1 OR revoked_at < $1`,
      [new Date(now - RETAIN_ENDED_MS)]
    );
  } catch { /* the next login will try again */ }
  await query(
    `INSERT INTO web_sessions (user_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [userId, hashToken(token), new Date(now + ABSOLUTE_MS), String(userAgent).slice(0, 200)]
  );
  return token;
}

/**
 * The user a live session belongs to, or null. Expiry, idle timeout and revocation are all
 * decided in the query, so a row that is not live never reaches the caller. Cut-off times
 * are computed here and passed as parameters, so the SQL holds no interval arithmetic.
 *
 * @returns {Promise<{ user: object, sessionId: number }|null>} `user` has the same columns
 *   the api_key lookup returns
 */
export async function findSessionUser({ query, token, now = Date.now() }) {
  if (!isSessionToken(token)) return null;
  const tokenHash = hashToken(token);
  const result = await query(
    `SELECT u.id, u.email, u.name, u.role, u.settings, u.created_at,
            s.id AS session_id,
            -- A re-typed password counts as a fresh login (POST /api/me/confirm-password).
            GREATEST(s.created_at, s.password_confirmed_at) AS session_created_at
       FROM web_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND s.last_seen_at > $2`,
    [tokenHash, new Date(now - IDLE_MS)]
  );
  const row = result.rows[0];
  if (!row) return null;
  // Best effort: a failed touch must not fail the request it rode in on.
  try {
    await query(
      `UPDATE web_sessions SET last_seen_at = NOW()
        WHERE id = $1 AND last_seen_at < $2`,
      [row.session_id, new Date(now - TOUCH_INTERVAL_MS)]
    );
  } catch { /* the session is still valid; the next request will try again */ }
  const { session_id: sessionId, session_created_at: sessionCreatedAt, ...user } = row;
  return { user, sessionId, sessionCreatedAt: sessionCreatedAt ? new Date(sessionCreatedAt) : null };
}

export async function revokeSession({ query, token }) {
  if (!isSessionToken(token)) return 0;
  const result = await query(
    `UPDATE web_sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)]
  );
  return result.rowCount ?? 0;
}

/**
 * Every live login of one account, optionally sparing the one making the request — a user
 * changing their own password stays logged in where they did it, and nowhere else.
 */
export async function revokeUserSessions({ query, userId, exceptSessionId = null }) {
  // Two statements rather than one with `$2 IS NULL OR id <> $2`: a parameter whose type
  // Postgres has to infer from a NULL is the kind of SQL that only fails in production.
  const result = exceptSessionId == null
    ? await query(
      `UPDATE web_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId])
    : await query(
      `UPDATE web_sessions SET revoked_at = NOW()
        WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`,
      [userId, exceptSessionId]);
  return result.rowCount ?? 0;
}

/**
 * Refuse a session whose login is older than RECENT_LOGIN_MS, for a route that answers with
 * an api_key. Returns true when the request may go on; otherwise it has already answered.
 * An api_key caller (no req.sessionId) always goes on.
 */
export function requireRecentLogin(req, res, now = Date.now()) {
  if (req.sessionId == null) return true;
  const created = req.sessionCreatedAt instanceof Date ? req.sessionCreatedAt.getTime() : NaN;
  if (Number.isFinite(created) && now - created <= RECENT_LOGIN_MS) return true;
  res.status(403).json({
    error: '這個動作會拿到金鑰，請先登出再重新登入，15 分鐘內再試一次',
    reauth_required: true,
  });
  return false;
}
