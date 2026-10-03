/**
 * GET /api/admin/users/:id/api-key — one user's full API key, for yourself or for someone
 * who ranks below you.
 *
 * The team page used to read every key from GET /api/admin/users, so any admin could copy
 * the super_admin's key and, because authentication looks a user up by key alone, become
 * the super_admin. The list now carries only a prefix; the full key comes from here, one
 * user at a time, and every reveal goes to the audit log (the key itself never does).
 *
 * The admin still needs a member's key: the install prompt they hand a new member carries
 * it. That is not nothing — a password reset is something the member notices, a revealed
 * key lets the admin act as them silently — which is why every reveal, and every refusal,
 * is in the audit log.
 *
 * Factory with injectable dependencies, like admin-password-reset.js, so it is tested
 * without a database.
 */
import { Router } from 'express';
import { query as defaultQuery } from '../utils/db.js';
import defaultAdminAuth from '../middleware/adminAuth.js';
import defaultLogger from '../utils/logger.js';
import { mayRevealKeyOf } from '../utils/roles.js';
import { requireRecentLogin } from '../utils/web-session.js';

/**
 * @param {object} [deps]
 * @param {Function} [deps.query]
 * @param {Function} [deps.adminAuth]
 * @param {object} [deps.logger]
 * @returns {import('express').Router}
 */
export function createAdminApiKeyRouter(deps = {}) {
  const query = deps.query || defaultQuery;
  const adminAuth = deps.adminAuth || defaultAdminAuth;
  const logger = deps.logger || defaultLogger;

  const router = Router();

  // On the route rather than router.use: this router is mounted at /api/admin/users ahead
  // of the main admin router, and router.use would run the check for every request there.
  router.get('/:id/api-key', adminAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // v1.31.1: a console session must be a recent login to come away with a key.
    if (!requireRecentLogin(req, res)) return;
    try {
      const targetId = /^\d{1,10}$/.test(req.params.id) ? parseInt(req.params.id, 10) : NaN;
      // Beyond a PostgreSQL integer the query would fail and answer 500.
      if (!Number.isSafeInteger(targetId) || targetId > 2147483647) {
        return res.status(400).json({ error: '使用者編號格式不對' });
      }

      const result = await query('SELECT id, role, api_key FROM users WHERE id = $1', [targetId]);
      const target = result.rows[0];
      if (!target) return res.status(404).json({ error: '找不到這個使用者' });

      const allowed = mayRevealKeyOf(req.user, target);
      // Written before any answer goes out, refusals included: an admin probing for the
      // super_admin's key should leave a row, not just a server log line. The key itself is
      // never part of it.
      await query(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user.id, allowed ? 'reveal_api_key' : 'reveal_api_key_denied', 'user', targetId,
          JSON.stringify({ actor_role: req.user.role, target_role: target.role })]
      );
      if (!allowed) {
        logger.warn('api_key reveal refused', { actor_id: req.user.id, target_id: targetId });
        return res.status(403).json({ error: '只能取得自己或職級比你低的人的金鑰' });
      }

      res.json({ id: target.id, api_key: target.api_key });
    } catch (err) {
      logger.error('api_key reveal failed', { error: err.message });
      res.status(500).json({ error: '取得金鑰失敗' });
    }
  });

  return router;
}

export default createAdminApiKeyRouter();
