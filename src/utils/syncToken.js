import crypto from 'crypto';
import { query as defaultQuery } from './db.js';

/**
 * Generate sync token based on current memory state for a user.
 * Token = hash of (user_id + max updated_at of user memories + max updated_at of
 * team_standards + the account's locale preference).
 * Any write operation changes one of those inputs → token changes → stale clients detected.
 *
 * v1.18.0: query is now injectable (backward compatible; defaults to db.js)
 *   Reason: integration-testing the GET /sync-token endpoint needs to mock query;
 *   without refactoring it would require spinning up an integration test. Minimal
 *   change — accept queryFn = defaultQuery so all existing callers stay unchanged
 *   while new tests can inject a fake.
 *
 * Task 5 fix round 1 (gate-message-i18n): `locale` joined the hash inputs. A locale write
 * (PUT /api/memory/locale) only touches `users.settings`, never `memories.updated_at` — so
 * without this, the token could never change on a locale-only write, and the existing
 * conditional-sync client (hooks/lib/conditional-sync.js), which decides whether to re-init
 * purely by comparing this token, would never notice the change. The preference would sit on
 * the server, invisible to every machine, until an unrelated write happened to bump the
 * token or the 24h staleness fallback fired. Both GET /sync-token and GET /init call this
 * same function, so they can never disagree about what the current token is.
 */
export async function generateSyncToken(userId, queryFn = defaultQuery) {
  const result = await queryFn(
    `SELECT
       COALESCE(MAX(updated_at)::text, '') AS user_max,
       (SELECT COALESCE(MAX(updated_at)::text, '')
        FROM memories WHERE type = 'team_standard' AND status = 'active') AS team_max,
       (SELECT COALESCE(settings->>'locale', '') FROM users WHERE id = $1) AS locale
     FROM memories
     WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );

  const { user_max, team_max, locale } = result.rows[0];
  const raw = `${userId}:${user_max}:${team_max}:${locale || ''}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

/**
 * Validate sync token from request.
 * Returns: { valid: true } | { valid: false, new_token: string }
 */
export async function validateSyncToken(userId, clientToken, queryFn = defaultQuery) {
  const currentToken = await generateSyncToken(userId, queryFn);

  if (!clientToken || clientToken !== currentToken) {
    return { valid: false, new_token: currentToken };
  }

  return { valid: true };
}
