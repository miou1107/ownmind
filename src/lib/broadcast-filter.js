/**
 * broadcast-filter.js — single source of truth deciding which broadcasts a (user, tool) should see
 *
 * Used in two places:
 *   - P2: `GET /api/broadcast/active?tool=X` → returns what the user should currently see
 *   - P4: MCP response middleware → decides whether to prepend it to the response text
 *
 * Filter rules (Spec S5):
 *   1. starts_at ≤ now and (ends_at IS NULL or ends_at > now)
 *   2. target_users IS NULL or user_id ∈ target_users
 *   3. min_version IS NULL or client_version ≥ min_version (semver)
 *   4. max_version IS NULL or client_version ≤ max_version (semver)
 *   5. no dismissed_at
 *   6. snooze_until IS NULL or snooze_until ≤ now
 *
 * Cooldown (used only for P4 injection) is handled separately after the return,
 * **not here**, because the /active endpoint "lists everything currently active" and
 * should not skip a broadcast just because it was recently injected.
 */

import { isLower, isHigher } from '../utils/semver.js';

/**
 * @param {(sql: string, params: any[]) => Promise<{rows: any[]}>} query
 * @param {Object} ctx
 * @param {number} ctx.user_id
 * @param {string} ctx.tool
 * @param {string} [ctx.client_version]  — if undefined / null, both min/max_version checks always pass
 * @param {Date}   [ctx.now=new Date()]
 * @returns {Promise<Array<BroadcastWithState>>}
 */
export async function filterVisibleBroadcasts(query, ctx) {
  const { user_id, tool, client_version, now = new Date() } = ctx;
  if (!Number.isInteger(user_id) || user_id <= 0) return [];
  if (typeof tool !== 'string' || !tool) return [];

  // SQL handles time + target_users + dismiss/snooze; semver is done in JS (avoids SQL complexity)
  const sql = `
    SELECT
      b.id, b.type, b.severity, b.title, b.body,
      b.cta_text, b.cta_action,
      b.min_version, b.max_version, b.target_users,
      b.allow_snooze, b.snooze_hours, b.cooldown_minutes,
      b.starts_at, b.ends_at, b.is_auto,
      s.dismissed_at, s.snooze_until, s.last_injected_at
    FROM broadcast_messages b
    LEFT JOIN user_broadcast_state s
      ON s.broadcast_id = b.id AND s.user_id = $1 AND s.tool = $2
    WHERE b.starts_at <= $3
      AND (b.ends_at IS NULL OR b.ends_at > $3)
      AND (b.target_users IS NULL OR $1 = ANY(b.target_users))
      AND s.dismissed_at IS NULL
      AND (s.snooze_until IS NULL OR s.snooze_until <= $3)
    ORDER BY
      CASE b.severity
        WHEN 'critical' THEN 0
        WHEN 'warning'  THEN 1
        ELSE 2
      END,
      b.starts_at DESC,
      b.id DESC
  `;
  const result = await query(sql, [user_id, tool, now]);

  // semver filter in JS
  return result.rows.filter((bc) => {
    if (client_version) {
      if (bc.min_version && isLower(client_version, bc.min_version)) return false;
      if (bc.max_version && isHigher(client_version, bc.max_version)) return false;
    }
    return true;
  });
}

/**
 * filterInjectable — applies cooldown on top of the filterVisibleBroadcasts result (for P4 inject)
 *
 * @param {Array} broadcasts  the result already filtered by filterVisibleBroadcasts
 * @param {Object} opts
 * @param {boolean} opts.forceInject  when true, overrides cooldown (pass true on first / every 4h)
 * @param {Date} [opts.now=new Date()]
 */
export function filterInjectable(broadcasts, { forceInject = false, now = new Date() } = {}) {
  if (forceInject) return broadcasts;
  const nowMs = now.getTime();
  return broadcasts.filter((bc) => {
    if (!bc.last_injected_at) return true;
    const elapsedMin = (nowMs - new Date(bc.last_injected_at).getTime()) / 60_000;
    return elapsedMin >= (bc.cooldown_minutes ?? 1440);
  });
}
