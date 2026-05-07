import { Router } from 'express';
import { query as defaultQuery } from '../utils/db.js';
import { superAdminAuth as defaultSuperAdminAuth } from '../middleware/adminAuth.js';

/**
 * /api/admin/work-log — super_admin only
 *
 *   GET / — 三來源時間軸：
 *     - activity_logs（event != 'iron_rule_compliance'）→ source='activity'
 *     - activity_logs（event = 'iron_rule_compliance'）→ source='compliance'
 *     - session_logs → source='session'
 *
 *   Query params（皆選填）：
 *     from         ISO date（預設：30 天前）
 *     to           ISO date（預設：now）
 *     user_id      INT
 *     tool         string
 *     event_type   string（activity 是 event 欄位；session 用 'session'）
 *     source       'activity' | 'compliance' | 'session'
 *     q            搜 details / summary（ILIKE %q%）
 *     limit        預設 100，max 500
 *     offset       預設 0
 *
 *   GET /filters — 給前端下拉用：users / tools / event_types
 */
export function createAdminWorkLogRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const superAdminAuth = deps.superAdminAuth ?? defaultSuperAdminAuth;

  const router = Router();

  router.get('/filters', superAdminAuth, async (_req, res) => {
    try {
      const [users, tools, events] = await Promise.all([
        query(`SELECT id, name, email FROM users ORDER BY name`),
        query(
          `SELECT DISTINCT tool FROM (
             SELECT tool FROM activity_logs WHERE tool IS NOT NULL
             UNION
             SELECT tool FROM session_logs WHERE tool IS NOT NULL
           ) t WHERE tool <> '' ORDER BY tool`
        ),
        query(
          `SELECT DISTINCT event FROM activity_logs WHERE event IS NOT NULL ORDER BY event`
        ),
      ]);
      res.json({
        users: users.rows,
        tools: tools.rows.map((r) => r.tool),
        event_types: events.rows.map((r) => r.event),
      });
    } catch (e) {
      res.status(500).json({ error: 'filters_failed', detail: e.message });
    }
  });

  router.get('/', superAdminAuth, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 100, 500);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const from =
        req.query.from || new Date(Date.now() - 30 * 86400000).toISOString();
      const to = req.query.to || new Date().toISOString();
      const userId = req.query.user_id ? parseInt(req.query.user_id) : null;
      const tool = req.query.tool || null;
      const eventType = req.query.event_type || null;
      const sourceFilter = req.query.source || null;
      const q = req.query.q ? String(req.query.q).trim() : null;

      const params = [from, to];
      const idx = (v) => {
        params.push(v);
        return `$${params.length}`;
      };

      const userClause = userId ? ` AND user_id = ${idx(userId)}` : '';
      const toolClause = tool ? ` AND tool = ${idx(tool)}` : '';
      const eventClause = eventType ? ` AND event = ${idx(eventType)}` : '';
      const qLike = q ? `%${q}%` : null;
      const qClauseActivity = qLike ? ` AND details::text ILIKE ${idx(qLike)}` : '';
      const qClauseSession = qLike
        ? ` AND (summary ILIKE ${idx(qLike)} OR details::text ILIKE ${idx(qLike)})`
        : '';

      const parts = [];
      if (!sourceFilter || sourceFilter === 'activity') {
        parts.push(`
          SELECT 'activity' AS source, al.id AS row_id, al.user_id, u.name AS user_name,
                 al.ts, al.event AS event_type, al.tool, al.source AS event_source,
                 al.details, NULL::text AS title, NULL::text AS summary
          FROM activity_logs al
          LEFT JOIN users u ON u.id = al.user_id
          WHERE al.event <> 'iron_rule_compliance'
            AND al.ts >= $1 AND al.ts <= $2
            ${userClause.replaceAll('user_id', 'al.user_id')}
            ${toolClause.replaceAll('tool =', 'al.tool =')}
            ${eventClause.replaceAll('event =', 'al.event =')}
            ${qClauseActivity.replaceAll('details::text', 'al.details::text')}
        `);
      }
      if (!sourceFilter || sourceFilter === 'compliance') {
        parts.push(`
          SELECT 'compliance' AS source, al.id AS row_id, al.user_id, u.name AS user_name,
                 al.ts, al.event AS event_type, al.tool, al.source AS event_source,
                 al.details, NULL::text AS title, NULL::text AS summary
          FROM activity_logs al
          LEFT JOIN users u ON u.id = al.user_id
          WHERE al.event = 'iron_rule_compliance'
            AND al.ts >= $1 AND al.ts <= $2
            ${userClause.replaceAll('user_id', 'al.user_id')}
            ${toolClause.replaceAll('tool =', 'al.tool =')}
            ${qClauseActivity.replaceAll('details::text', 'al.details::text')}
        `);
      }
      if (!sourceFilter || sourceFilter === 'session') {
        parts.push(`
          SELECT 'session' AS source, sl.id AS row_id, sl.user_id, u.name AS user_name,
                 sl.created_at AS ts, 'session_log' AS event_type, sl.tool,
                 NULL::text AS event_source, sl.details,
                 sl.session_id AS title, sl.summary
          FROM session_logs sl
          LEFT JOIN users u ON u.id = sl.user_id
          WHERE sl.created_at >= $1 AND sl.created_at <= $2
            ${userClause.replaceAll('user_id', 'sl.user_id')}
            ${toolClause.replaceAll('tool =', 'sl.tool =')}
            ${qClauseSession}
        `);
      }

      if (parts.length === 0) {
        return res.json({ rows: [], total: 0, limit, offset });
      }

      const sql = `
        WITH merged AS (${parts.join(' UNION ALL ')})
        SELECT *, COUNT(*) OVER () AS total_count
        FROM merged
        ORDER BY ts DESC
        LIMIT ${idx(limit)} OFFSET ${idx(offset)}
      `;

      const result = await query(sql, params);
      const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;
      const rows = result.rows.map((r) => {
        const { total_count, ...rest } = r;
        return rest;
      });

      res.json({ rows, total, limit, offset, from, to });
    } catch (e) {
      res.status(500).json({ error: 'work_log_failed', detail: e.message });
    }
  });

  return router;
}

export default createAdminWorkLogRouter();
