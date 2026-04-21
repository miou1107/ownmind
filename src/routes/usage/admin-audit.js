import { Router } from 'express';
import { query as defaultQuery } from '../../utils/db.js';
import defaultAdminAuth from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';

const VALID_EVENT_TYPES = new Set([
  'unknown_model', 'token_regression', 'rate_anomaly',
  'fingerprint_collision', 'fingerprint_mismatch', 'codex_missing_material',
  'ingestion_suppressed_exempt',
  'exemption_granted', 'exemption_reason_updated', 'exemption_revoked'
]);

/**
 * GET /api/usage/admin/audit?event_type=&user_id=&limit=  (admin+)
 *
 * 最近 N 筆 usage_audit_log。用於 dashboard 的 audit 子頁 + debug。
 * 不允許任意 event_type，只能從 VALID_EVENT_TYPES 挑。
 */
export function createAdminAuditRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const adminAuth = deps.adminAuth ?? defaultAdminAuth;

  const router = Router();

  router.get('/', adminAuth, async (req, res) => {
    try {
      const { event_type, user_id } = req.query || {};
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

      if (event_type && !VALID_EVENT_TYPES.has(event_type)) {
        return res.status(400).json({
          error: 'event_type 不在允許清單',
          allowed: [...VALID_EVENT_TYPES]
        });
      }

      const conditions = [];
      const params = [];
      if (event_type) { params.push(event_type); conditions.push(`event_type = $${params.length}`); }
      if (user_id) {
        const uid = parseInt(user_id, 10);
        if (Number.isFinite(uid)) { params.push(uid); conditions.push(`user_id = $${params.length}`); }
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);
      const sql = `
        SELECT a.id, a.user_id, u.name AS user_name, a.tool, a.event_type, a.details, a.ts
          FROM usage_audit_log a
     LEFT JOIN users u ON u.id = a.user_id
        ${where}
        ORDER BY a.ts DESC
        LIMIT $${params.length}`;

      const result = await query(sql, params);
      res.json(result.rows);
    } catch (err) {
      logger.error('audit log 查詢失敗', { error: err.message });
      res.status(500).json({ error: '查詢 audit log 失敗' });
    }
  });

  return router;
}

export default createAdminAuditRouter();
