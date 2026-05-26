import { Router } from 'express';
import { query as defaultQuery } from '../../utils/db.js';
import { superAdminAuth as defaultSuperAdminAuth } from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';

/**
 * /api/usage/exemptions — super_admin only (D3).
 *
 *   GET    list every exemption.
 *   POST   add one: { user_id, reason, expires_at? }; reason is required.
 *   DELETE /:user_id remove one, writing usage_audit_log
 *                    (event_type='exemption_revoked').
 *
 * Auditing the revocation is required: data missing during an exemption
 * window is legitimately absent, but without a record of who revoked when,
 * later review can't distinguish "no one ever reported" from "this user
 * was exempted at the time."
 */
export function createExemptionsRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const superAdminAuth = deps.superAdminAuth ?? defaultSuperAdminAuth;

  const router = Router();

  router.get('/', superAdminAuth, async (_req, res) => {
    try {
      const result = await query(
        `SELECT e.user_id, u.name, u.email,
                e.granted_by, gu.name AS granted_by_name,
                e.reason, e.granted_at, e.expires_at
           FROM usage_tracking_exemption e
           JOIN users u  ON u.id  = e.user_id
      LEFT JOIN users gu ON gu.id = e.granted_by
          ORDER BY e.granted_at DESC`
      );
      res.json(result.rows);
    } catch (err) {
      logger.error('exemption query failed', { error: err.message });
      res.status(500).json({ error: 'Failed to query exemptions' });
    }
  });

  router.post('/', superAdminAuth, async (req, res) => {
    try {
      const { user_id, reason, expires_at } = req.body || {};
      if (!user_id) return res.status(400).json({ error: 'user_id is required' });
      if (!reason || !String(reason).trim()) {
        return res.status(400).json({ error: 'reason is required' });
      }
      if (expires_at && Number.isNaN(new Date(expires_at).getTime())) {
        return res.status(400).json({ error: 'expires_at has invalid format' });
      }

      // First check whether one already exists, to decide the audit event_type.
      // (granted = new approval; reason_updated = modifying an existing one;
      // they have different audit meanings.)
      const prior = await query(
        `SELECT reason, expires_at FROM usage_tracking_exemption WHERE user_id = $1`,
        [user_id]
      );

      const trimmed = String(reason).trim();
      const result = await query(
        `INSERT INTO usage_tracking_exemption (user_id, granted_by, reason, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
           granted_by = EXCLUDED.granted_by,
           reason     = EXCLUDED.reason,
           expires_at = EXCLUDED.expires_at,
           granted_at = NOW()
         RETURNING user_id, granted_by, reason, granted_at, expires_at`,
        [user_id, req.user.id, trimmed, expires_at ?? null]
      );

      const isUpdate = prior.rows.length > 0;
      const auditType = isUpdate ? 'exemption_reason_updated' : 'exemption_granted';
      const details = isUpdate
        ? {
            target_user_id: user_id,
            prior_reason: prior.rows[0].reason,
            new_reason: trimmed,
            prior_expires_at: prior.rows[0].expires_at,
            new_expires_at: expires_at ?? null
          }
        : { target_user_id: user_id, reason: trimmed, expires_at: expires_at ?? null };
      await writeAudit({ query }, req.user.id, null, auditType, details);

      res.status(isUpdate ? 200 : 201).json(result.rows[0]);
    } catch (err) {
      logger.error('exemption insert failed', { error: err.message });
      res.status(500).json({ error: 'Failed to add exemption' });
    }
  });

  router.delete('/:user_id', superAdminAuth, async (req, res) => {
    try {
      const targetId = parseInt(req.params.user_id, 10);
      if (!Number.isFinite(targetId)) {
        return res.status(400).json({ error: 'user_id must be an integer' });
      }

      const result = await query(
        `DELETE FROM usage_tracking_exemption WHERE user_id = $1
         RETURNING user_id, reason, granted_at`,
        [targetId]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'exemption not found' });
      }

      await writeAudit({ query }, req.user.id, null, 'exemption_revoked', {
        target_user_id: targetId, prior_reason: result.rows[0].reason
      });

      res.json({ message: 'exemption removed', user_id: targetId });
    } catch (err) {
      logger.error('exemption remove failed', { error: err.message });
      res.status(500).json({ error: 'Failed to remove exemption' });
    }
  });

  return router;
}

async function writeAudit({ query }, userId, tool, eventType, details) {
  try {
    await query(
      `INSERT INTO usage_audit_log (user_id, tool, event_type, details)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [userId, tool, eventType, JSON.stringify(details)]
    );
  } catch (err) {
    logger.error('usage_audit_log write failed', { error: err.message });
  }
}

export default createExemptionsRouter();
