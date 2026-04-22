/**
 * broadcast-filter.js — 單一 source of truth 決定 (user, tool) 該看到哪些廣播
 *
 * 被以下兩處使用：
 *   - P2: `GET /api/broadcast/active?tool=X` → 回傳 user 當下應看到的
 *   - P4: MCP response middleware → 決定要不要 prepend 到 response text
 *
 * 過濾規則（Spec S5）：
 *   1. starts_at ≤ now 且 (ends_at IS NULL 或 ends_at > now)
 *   2. target_users IS NULL 或 user_id ∈ target_users
 *   3. min_version IS NULL 或 client_version ≥ min_version（semver）
 *   4. max_version IS NULL 或 client_version ≤ max_version（semver）
 *   5. 無 dismissed_at
 *   6. snooze_until IS NULL 或 snooze_until ≤ now
 *
 * Cooldown（只在 P4 injection 用）在回傳後另外處理，**不放在這裡**，
 * 因為 /active 端點是「列出所有目前生效」，不該因為剛 inject 過就跳過。
 */

import { isLower, isHigher } from '../utils/semver.js';

/**
 * @param {(sql: string, params: any[]) => Promise<{rows: any[]}>} query
 * @param {Object} ctx
 * @param {number} ctx.user_id
 * @param {string} ctx.tool
 * @param {string} [ctx.client_version]  — 若 undefined / null，min/max_version 兩檢查一律通過
 * @param {Date}   [ctx.now=new Date()]
 * @returns {Promise<Array<BroadcastWithState>>}
 */
export async function filterVisibleBroadcasts(query, ctx) {
  const { user_id, tool, client_version, now = new Date() } = ctx;
  if (!Number.isInteger(user_id) || user_id <= 0) return [];
  if (typeof tool !== 'string' || !tool) return [];

  // SQL 處理時間 + target_users + dismiss/snooze；semver 在 JS 做（避免 SQL 複雜度）
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
 * filterInjectable — 在 filterVisibleBroadcasts 的結果上再套 cooldown（P4 inject 用）
 *
 * @param {Array} broadcasts  已經過 filterVisibleBroadcasts 的
 * @param {Object} opts
 * @param {boolean} opts.forceInject  true 時覆蓋 cooldown（首次 / 隔 4h 時 pass true）
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
