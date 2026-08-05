import { SEARCH_ROW_LIMIT } from '../../shared/memory-search-result.js';

/**
 * src/lib/session-query.js
 *
 * Pure function: builds the SQL query for GET /api/session/recent. Extracted for
 * easy unit testing.
 * v1.17.13 added the `q` parameter (search summary + details ILIKE), fixing the
 * "ownmind_search can't find a session topic that was just logged" bug Dana
 * reported (session_logs are separate from memories, so memory search doesn't cover them).
 */

/**
 * The columns the two readers actually use: mcp/index.js maps id / summary / details /
 * tool / model / created_at into its merged search result, and the console's session
 * views read the same set. Named rather than `*` for the reason in
 * shared/memory-search-result.js: `*` ships whatever the table grows next.
 */
const SELECTED_COLUMNS = [
  'id', 'user_id', 'tool', 'model', 'summary', 'details',
  'compressed', 'created_at',
];

/**
 * The ceiling on any single answer. A caller may ask for less; nothing may ask for more,
 * because the point of the cap is that no request can produce an unbounded response.
 */
export const SESSION_MAX_LIMIT = 50;

export function buildSessionRecentQuery({
  userId,
  days = 7,
  tool = null,
  includeCompressed = false,
  q = null,
  limit = SEARCH_ROW_LIMIT,
} = {}) {
  const parts = [`SELECT ${SELECTED_COLUMNS.join(', ')} FROM session_logs WHERE user_id = $1`];
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
  // v1.26.64 — Bug #11. After ORDER BY, so the cap keeps the newest rather than
  // whichever rows the planner reached first. `ownmind_search` merges this into the same
  // response as the memory half, so leaving it unbounded would let the output ceiling be
  // exceeded through a different route.
  //
  // The limit is a parameter because this builder has two callers with different jobs:
  // search wants a handful of hits merged with memories, while `ownmind_get('session_log')`
  // is a listing and a cap of 20 would silently hide a month of work. Review of this
  // release caught that the first version capped both at 20 without noticing the second
  // caller existed.
  const bounded = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, SESSION_MAX_LIMIT)
    : SEARCH_ROW_LIMIT;
  parts.push(`LIMIT ${bounded}`);

  return { text: parts.join(' '), values };
}
