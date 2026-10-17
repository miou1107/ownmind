/**
 * POST /api/admin/users/:id/deactivate and /reactivate — turn an account off without
 * deleting it.
 *
 * 2026-10-11: a colleague left. Deleting the account would take every memory with it;
 * leaving it kept a working key and kept the person in every team count. A deactivated
 * account cannot authenticate (the auth middleware and the session lookup both skip it),
 * its key is replaced on the spot so the old one is dead even after a reactivation, its
 * console logins are ended, and team rosters leave it out. Its data stays.
 *
 * super_admin only, like deleting an account, and never yourself or the first account.
 *
 * Factory with injectable dependencies, like admin-api-key.js, so it is tested without a
 * database.
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query as defaultQuery } from '../utils/db.js';
import defaultAdminAuth from '../middleware/adminAuth.js';
import defaultLogger from '../utils/logger.js';

export function createAccountStatusRouter(deps = {}) {
  const query = deps.query || defaultQuery;
  const adminAuth = deps.adminAuth || defaultAdminAuth;
  const logger = deps.logger || defaultLogger;

  const router = Router();

  // Shared checks; answers and returns null when the request may not go on.
  async function loadTarget(req, res) {
    if (req.user.role !== 'super_admin') {
      res.status(403).json({ error: '只有超級管理員可以停用帳號' });
      return null;
    }
    const targetId = /^\d{1,10}$/.test(req.params.id) ? parseInt(req.params.id, 10) : NaN;
    if (!Number.isSafeInteger(targetId) || targetId > 2147483647) {
      res.status(400).json({ error: '使用者編號格式不對' });
      return null;
    }
    if (targetId === req.user.id) {
      res.status(400).json({ error: '不能停用自己的帳號' });
      return null;
    }
    if (targetId === 1) {
      res.status(400).json({ error: '不能停用主帳號' });
      return null;
    }
    const result = await query(
      'SELECT id, email, role, deactivated_at FROM users WHERE id = $1', [targetId]);
    if (!result.rows[0]) {
      res.status(404).json({ error: '找不到這個使用者' });
      return null;
    }
    return result.rows[0];
  }

  const audit = (actor, action, target) => query(
    `INSERT INTO audit_logs (actor_id, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [actor.id, action, 'user', target.id, JSON.stringify({ email: target.email, target_role: target.role })]
  );

  router.post('/:id/deactivate', adminAuth, async (req, res) => {
    try {
      const target = await loadTarget(req, res);
      if (!target) return;
      // A new random key nobody is shown: the old one stops working now, and a later
      // reactivation hands out an install prompt with this one, never the old one.
      await query(
        `UPDATE users SET deactivated_at = NOW(), deactivated_by = $2, api_key = $3, updated_at = NOW()
          WHERE id = $1`,
        [target.id, req.user.id, randomUUID()]
      );
      await query(
        'UPDATE web_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
        [target.id]
      );
      try {
        await audit(req.user, 'deactivate_user', target);
      } catch (err) {
        logger.error('account deactivated but audit write failed', { error: err.message, target_id: target.id });
      }
      res.json({ id: target.id, deactivated: true });
    } catch (err) {
      logger.error('deactivate user failed', { error: err.message });
      res.status(500).json({ error: '停用帳號失敗' });
    }
  });

  router.post('/:id/reactivate', adminAuth, async (req, res) => {
    try {
      const target = await loadTarget(req, res);
      if (!target) return;
      await query(
        `UPDATE users SET deactivated_at = NULL, deactivated_by = NULL, updated_at = NOW()
          WHERE id = $1`,
        [target.id]
      );
      try {
        await audit(req.user, 'reactivate_user', target);
      } catch (err) {
        logger.error('account reactivated but audit write failed', { error: err.message, target_id: target.id });
      }
      res.json({ id: target.id, deactivated: false });
    } catch (err) {
      logger.error('reactivate user failed', { error: err.message });
      res.status(500).json({ error: '重新啟用失敗' });
    }
  });

  return router;
}

export default createAccountStatusRouter();
