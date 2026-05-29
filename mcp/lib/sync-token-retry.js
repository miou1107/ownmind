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
 * Fix: the MCP client intercepts a sync_token 409 (identified by the response
 * body's code — sync_token_stale / sync_token_required — with a message-text
 * fallback for older servers that don't send a code), GETs /api/memory/sync-token
 * to fetch the new token, updates body.sync_token, and retries once. Completely
 * transparent to the AI.
 *
 * Constraints:
 *   - Only retry once — avoid infinite loops.
 *   - Only for write operations (not GET / HEAD).
 *   - Must genuinely be a sync_token 409 — detected via body.code, falling back
 *     to a message match. Not every 409 should retry.
 */

/**
 * Decide whether the error should be auto-retried.
 * @param {object} param - { method, status, errorMessage, body }
 *   - body: the parsed 409 response body, if available. Preferred signal.
 * @returns {boolean}
 */
export function shouldRetryForSyncToken({ method, status, errorMessage, body }) {
  // GET / HEAD are reads and don't touch sync_token logic — never retry.
  if (method === 'GET' || method === 'HEAD') return false;

  // Must be a 409 conflict.
  if (status !== 409) return false;

  // Preferred: the server tags sync_token 409s with an explicit code, so
  // detection does not depend on message wording. This is what catches the
  // stale-token case, whose message ("State has changed …") contains no
  // "sync_token" substring.
  if (body && (body.code === 'sync_token_stale' || body.code === 'sync_token_required')) {
    return true;
  }

  // Backward-compat fallback for older servers that don't send a code: match
  // the message text (avoid retrying unrelated 409s).
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
