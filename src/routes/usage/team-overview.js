import { Router } from 'express';
import { query as defaultQuery } from '../../utils/db.js';
import defaultAdminAuth from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';

/**
 * 從 session_logs.details 計算單一 session 的鐵律遵守。
 * 回傳 { complied, skipped, triggered }。triggered = complied + skipped。
 * details 為 null / 沒對應欄位時，三個值皆為 0。
 */
export function extractRuleCounts(details) {
  if (!details || typeof details !== 'object') return { complied: 0, skipped: 0, triggered: 0 };
  const complied = Array.isArray(details.rules_complied) ? details.rules_complied.length : 0;
  const skipped = Array.isArray(details.rules_skipped) ? details.rules_skipped.length : 0;
  return { complied, skipped, triggered: complied + skipped };
}

/**
 * 把多場 session 的 rule counts 加總，回傳 { complied, triggered, rate }。
 * triggered === 0 時 rate 為 null（前端顯示「—」、不參與排名）。
 */
export function aggregateCompliance(sessions) {
  let complied = 0, triggered = 0;
  for (const s of sessions) {
    const c = extractRuleCounts(s.details);
    complied += c.complied;
    triggered += c.triggered;
  }
  return {
    complied,
    triggered,
    rate: triggered === 0 ? null : complied / triggered
  };
}

/**
 * 從多場 session 票選最常做的專案（details.project）。
 * count 相同走字典序。所有 session 都沒 project → null。
 */
export function pickTopProject(sessions) {
  const counts = new Map();
  for (const s of sessions) {
    const p = s?.details?.project;
    if (typeof p !== 'string' || !p) continue;
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0], 'en', { sensitivity: 'base' });
  })[0][0];
}

export function createTeamOverviewRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const adminAuth = deps.adminAuth ?? defaultAdminAuth;
  const router = Router();
  // routes 待 Task 2 起逐步補入
  router.get('/', adminAuth, async (req, res) => {
    try {
      const to = req.query.to ? new Date(req.query.to) : new Date();
      const from = req.query.from
        ? new Date(req.query.from)
        : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

      const sql = `
        SELECT u.id AS user_id,
               u.name AS user_name,
               MAX(sl.created_at) AS last_active_at,
               COUNT(sl.id)::int AS session_count,
               jsonb_agg(jsonb_build_object('details', sl.details)
                         ORDER BY sl.created_at DESC) AS sessions_json
          FROM users u
          JOIN session_logs sl ON sl.user_id = u.id
         WHERE sl.created_at >= $1 AND sl.created_at <= $2
         GROUP BY u.id, u.name
         ORDER BY MAX(sl.created_at) DESC`;
      const result = await query(sql, [from.toISOString(), to.toISOString()]);

      const members = result.rows.map(row => {
        const sessions = Array.isArray(row.sessions_json) ? row.sessions_json : [];
        const compliance = aggregateCompliance(sessions);
        return {
          user_id: row.user_id,
          user_name: row.user_name,
          last_active_at: row.last_active_at,
          session_count: row.session_count,
          top_project: pickTopProject(sessions),
          rule_compliance: compliance.triggered === 0 ? null : compliance
        };
      });

      res.json({
        range: { from: from.toISOString(), to: to.toISOString() },
        members
      });
    } catch (err) {
      logger.error('team-overview 查詢失敗', { error: err.message });
      res.status(500).json({ error: '查詢失敗' });
    }
  });

  return router;
}

export default createTeamOverviewRouter();
