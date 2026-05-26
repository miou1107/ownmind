/**
 * v1.20.2 follow-up #2: on write 409 sync_token stale → auto-fetch a new token and retry.
 *
 * Background:
 * sync_token is the per-user version marker on the server, incremented on every write.
 * It exists to prevent "stale-data overwrite". But when the user has multiple AI sessions
 * writing concurrently, session A's token gets bumped by session B's writes; A's next write
 * then 409s and the AI has to manually re-run ownmind_init to fetch a fresh token. This is a
 * bad UX and happens in practice on every write.
 *
 * Fix: the MCP client intercepts a 409 whose message mentions sync_token, GETs
 * /api/memory/sync-token to fetch the new token, updates body.sync_token, and retries once.
 * Completely transparent to the AI.
 *
 * Constraints:
 *   - Only retry once — avoid infinite loops.
 *   - Only for write operations (not GET / HEAD).
 *   - Must genuinely be a sync_token stale error (message must contain "sync_token") —
 *     not every 409 should retry.
 */

/**
 * Decide whether the error should be auto-retried.
 * @param {object} param - { method, status, errorMessage }
 * @returns {boolean}
 */
export function shouldRetryForSyncToken({ method, status, errorMessage }) {
  // GET / HEAD are reads and don't touch sync_token logic — never retry.
  if (method === 'GET' || method === 'HEAD') return false;

  // Must be a 409 conflict.
  if (status !== 409) return false;

  // Must be a sync_token-related error (avoid retrying unrelated 409s).
  return /sync_token/i.test(errorMessage || '');
}

/**
 * Replace sync_token in the body with the new value.
 * @param {object} body - request body
 * @param {string} newToken - new token value
 * @returns {boolean} - whether the swap succeeded (false if the body has no sync_token field)
 */
export function applyNewToken(body, newToken) {
  if (!newToken) return false;
  if (!body || typeof body !== 'object') return false;
  if (!('sync_token' in body)) return false;
  body.sync_token = newToken;
  return true;
}
