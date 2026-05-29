/**
 * src/lib/session-query.js
 *
 * Pure function: builds the SQL query for GET /api/session/recent. Extracted for
 * easy unit testing.
 * v1.17.13 added the `q` parameter (search summary + details ILIKE), fixing the
 * "ownmind_search can't find a session topic that was just logged" bug Michelle
 * reported (session_logs are separate from memories, so memory search doesn't cover them).
 */

export function buildSessionRecentQuery({
  userId,
  days = 7,
  tool = null,
  includeCompressed = false,
  q = null,
} = {}) {
  const parts = [`SELECT * FROM session_logs WHERE user_id = $1`];
  const values = [userId];
  let idx = 2;

  if (!includeCompressed) {
    parts.push(`AND compressed = false`);
  }

  parts.push(`AND created_at >= NOW() - INTERVAL '1 day' * $${idx}`);
  values.push(days);
  idx += 1;

  if (tool) {
    parts.push(`AND tool = $${idx}`);
    values.push(tool);
    idx += 1;
  }

  if (typeof q === 'string' && q.length > 0) {
    parts.push(`AND (summary ILIKE $${idx} OR COALESCE(details::text, '') ILIKE $${idx})`);
    values.push(`%${q}%`);
    idx += 1;
  }

  parts.push(`ORDER BY created_at DESC`);

  return { text: parts.join(' '), values };
}
