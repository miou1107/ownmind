import crypto from 'crypto';
import { query as defaultQuery } from './db.js';

/**
 * Generate sync token based on current memory state for a user.
 * Token = hash of (user_id + max updated_at of user memories + max updated_at of team_standards)
 * Any write operation changes updated_at → token changes → stale clients detected.
 *
 * v1.18.0: query is now injectable (backward compatible; defaults to db.js)
 *   Reason: integration-testing the GET /sync-token endpoint needs to mock query;
 *   without refactoring it would require spinning up an integration test. Minimal
 *   change — accept queryFn = defaultQuery so all existing callers stay unchanged
 *   while new tests can inject a fake.
 */
export async function generateSyncToken(userId, queryFn = defaultQuery) {
  const result = await queryFn(
    `SELECT
       COALESCE(MAX(updated_at)::text, '') AS user_max,
       (SELECT COALESCE(MAX(updated_at)::text, '')
        FROM memories WHERE type = 'team_standard' AND status = 'active') AS team_max
     FROM memories
     WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );

  const { user_max, team_max } = result.rows[0];
  const raw = `${userId}:${user_max}:${team_max}`;
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
