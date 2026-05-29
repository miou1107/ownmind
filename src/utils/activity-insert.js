/**
 * Shared activity log INSERT helper (v1.17.99)
 *
 * Why it exists (resolves v1.17.98 review I1):
 *   v1.17.98's dedup INSERT logic (NULL path = plain INSERT, has-id path = ON CONFLICT)
 *   lived inside the router handler in src/routes/activity.js. tests/activity-batch-dedup.test.js
 *   could only test a simplified copy and could not hit the real handler — so logic
 *   drift between them was untestable.
 *
 *   v1.17.99 extracts the dedup INSERT into this pure module; the handler imports it
 *   and the test imports the same copy. From now on the test and the real handler run
 *   the same code, resolving the I1 limitation.
 *
 * Pure module — no side effects (the query function is injected by the caller),
 * easy to test, cross-platform.
 */

// UUID v4 format check (client_event_id must be a valid UUID, otherwise treated as absent)
// Guards against clients stuffing in arbitrary strings and polluting the
// (user_id, client_event_id) unique index
export const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Normalize a client-supplied client_event_id into a "valid UUID v4" or null.
 * Invalid UUIDs (empty string, non-string, v1/v3/v5, garbage) are all treated as NULL.
 */
export function normalizeClientEventId(raw) {
  return (typeof raw === 'string' && UUID_V4_REGEX.test(raw)) ? raw : null;
}

/**
 * Write one activity_logs row.
 *
 * Two separate paths (v1.17.98 review B1):
 *   - clientEventId === null → plain INSERT (no ON CONFLICT clause, to avoid relying
 *     on partial unique index inference's edge behavior for NULL rows)
 *   - clientEventId is a valid UUID v4 → INSERT with ON CONFLICT DO NOTHING dedup
 *
 * @param {Function} query - PG query function (sql, params) → {rows: [...]}
 * @param {Object} args
 * @param {number} args.userId
 * @param {string} args.ts        - ISO 8601 timestamp
 * @param {string} args.event     - event type (e.g. 'iron_rule_compliance')
 * @param {string|null} args.tool
 * @param {string|null} args.source
 * @param {Object} args.details   - JSONB column
 * @param {string|null} args.clientEventId - the normalized UUID v4, or null
 * @returns {Promise<{inserted: boolean}>} inserted=false means dedup skipped it
 */
export async function insertActivityLog(query, args) {
  const { userId, ts, event, tool, source, details, clientEventId } = args;

  if (clientEventId === null) {
    // NULL path: plain INSERT, no client_event_id column
    const r = await query(
      `INSERT INTO activity_logs (user_id, ts, event, tool, source, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [userId, ts, event, tool, source, details]
    );
    return { inserted: r.rows.length > 0 };
  }

  // has-id path: ON CONFLICT DO NOTHING, partial unique index dedup
  const r = await query(
    `INSERT INTO activity_logs (user_id, ts, event, tool, source, details, client_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, client_event_id) WHERE client_event_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [userId, ts, event, tool, source, details, clientEventId]
  );
  // when ON CONFLICT skips, RETURNING yields 0 rows
  return { inserted: r.rows.length > 0 };
}
