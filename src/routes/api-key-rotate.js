/**
 * Replace an API key.
 *
 *   POST /api/me/rotate-key                — your own
 *   POST /api/admin/users/:id/rotate-key   — someone ranked below you, or yourself
 *
 * Until this existed a leaked key could not be revoked: nothing wrote api_key after an
 * account was created, and a password change left the key alone. Authentication finds a
 * user by key alone, so a leaked key was the account, for good.
 *
 * The old key stops working the moment the UPDATE commits. Every machine that held it has
 * to be given the new one — scripts/install-helpers/swap-api-key.cjs rewrites a machine's
 * configs and checks the result. The new key is returned exactly once and is never written
 * to the audit log; neither is the old one.
 *
 * Mounted at /api, ahead of the admin and me routers. Factory with injectable dependencies
 * so it is tested without a database.
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { query as defaultQuery } from '../utils/db.js';
import defaultAuth from '../middleware/auth.js';
import defaultAdminAuth from '../middleware/adminAuth.js';
import defaultLogger from '../utils/logger.js';
import { mayRevealKeyOf } from '../utils/roles.js';
import { requireRecentLogin } from '../utils/web-session.js';

/**
 * @param {object} [deps]
 * @param {Function} [deps.query]
 * @param {Function} [deps.auth]
 * @param {Function} [deps.adminAuth]
 * @param {object} [deps.logger]
 */
export function createApiKeyRotateRouter(deps = {}) {
  const query = deps.query || defaultQuery;
  const auth = deps.auth || defaultAuth;
  const adminAuth = deps.adminAuth || defaultAdminAuth;
  const logger = deps.logger || defaultLogger;

  const audit = (actor, action, targetId, targetRole) => query(
    `INSERT INTO audit_logs (actor_id, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [actor.id, action, 'user', targetId, JSON.stringify({ actor_role: actor.role, target_role: targetRole })]
  );

  async function rotate(actor, targetId, targetRole, res) {
    const newKey = randomUUID();
    const result = await query(
      'UPDATE users SET api_key = $1, updated_at = NOW() WHERE id = $2 RETURNING id, api_key',
      [newKey, targetId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: '找不到這個使用者' });
    // The key has changed by now. If the audit write fails, answering 500 would leave the
    // caller believing nothing happened while the old key is already dead and the new one
    // went to nobody — so a failed audit is logged loudly and the new key still goes out.
    try {
      await audit(actor, 'rotate_api_key', targetId, targetRole);
    } catch (err) {
      logger.error('api_key rotated but audit write failed', { error: err.message, actor_id: actor.id, target_id: targetId });
    }
    logger.info('api_key rotated', { actor_id: actor.id, target_id: targetId });
    res.json({ id: result.rows[0].id, api_key: result.rows[0].api_key });
  }

  const router = Router();

  router.post('/me/rotate-key', auth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // v1.31.1: the answer is a new api_key, so a console session must be a recent login.
    if (!requireRecentLogin(req, res)) return;
    try {
      await rotate(req.user, req.user.id, req.user.role, res);
    } catch (err) {
      logger.error('api_key rotate failed', { error: err.message });
      res.status(500).json({ error: '更換金鑰失敗' });
    }
  });

  router.post('/admin/users/:id/rotate-key', adminAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // v1.31.1: the answer is a new api_key, so a console session must be a recent login.
    if (!requireRecentLogin(req, res)) return;
    try {
      const targetId = /^\d{1,10}$/.test(req.params.id) ? parseInt(req.params.id, 10) : NaN;
      if (!Number.isSafeInteger(targetId) || targetId > 2147483647) {
        return res.status(400).json({ error: '使用者編號格式不對' });
      }
      const found = await query('SELECT id, role FROM users WHERE id = $1', [targetId]);
      const target = found.rows[0];
      if (!target) return res.status(404).json({ error: '找不到這個使用者' });

      // Same rule as revealing a key: holding the power to issue someone a new key is
      // holding their account.
      if (!mayRevealKeyOf(req.user, target)) {
        await audit(req.user, 'rotate_api_key_denied', targetId, target.role);
        logger.warn('api_key rotate refused', { actor_id: req.user.id, target_id: targetId });
        return res.status(403).json({ error: '只能更換自己或職級比你低的人的金鑰' });
      }
      await rotate(req.user, targetId, target.role, res);
    } catch (err) {
      logger.error('api_key rotate failed', { error: err.message });
      res.status(500).json({ error: '更換金鑰失敗' });
    }
  });

  return router;
}

export default createApiKeyRotateRouter();
