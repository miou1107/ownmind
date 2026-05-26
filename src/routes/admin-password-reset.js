/**
 * Admin emergency password reset for other users — v1.19.9.
 *
 * Corresponds to openspec/changes/v1.19.9-password-recovery/spec.md
 * scenarios 1-7.
 *
 * Difference from the existing POST /api/admin/users/:id/password:
 *   - The existing endpoint is "intentional change": requires the old
 *     password, the user picks their new one.
 *   - This endpoint is "forgot-password recovery": the system generates a
 *     random temporary password and forces a change on next login.
 *
 * Permissions:
 *   - super_admin can reset anyone (admin / user).
 *   - admin can reset users (not other admin / super_admin).
 *   - You cannot reset yourself (use POST /api/me/change-password).
 *
 * Design: factory pattern, injectable dependencies, easy to unit-test.
 */
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { query as defaultQuery } from '../utils/db.js';
import defaultAdminAuth, { isAtLeast as defaultIsAtLeast } from '../middleware/adminAuth.js';
import defaultLogger from '../utils/logger.js';
import { generateRandomPassword } from '../../shared/random-password.js';

const BCRYPT_ROUNDS = 10;

// v1.19.10: generateTempPassword moved to shared/random-password.js for reuse.
// The re-export here keeps backward compatibility (v1.19.9 tests reference it).
export const generateTempPassword = generateRandomPassword;

/**
 * Build the admin password reset router.
 *
 * @param {object} [deps]
 * @param {Function} [deps.query]
 * @param {Function} [deps.adminAuth] - defaults to the real adminAuth middleware
 * @param {Function} [deps.isAtLeast]
 * @param {object} [deps.logger]
 * @returns {import('express').Router}
 */
export function createAdminPasswordResetRouter(deps = {}) {
  const query = deps.query || defaultQuery;
  const adminAuth = deps.adminAuth || defaultAdminAuth;
  const isAtLeast = deps.isAtLeast || defaultIsAtLeast;
  const logger = deps.logger || defaultLogger;

  const router = Router();
  router.use(adminAuth);

  router.post('/:id/reset-password', async (req, res) => {
    try {
      const targetId = parseInt(req.params.id, 10);
      const actorId = req.user.id;
      const actorRole = req.user.role;

      // Scenario 4: cannot reset yourself.
      if (targetId === actorId) {
        return res.status(400).json({
          error: '不能重設自己的密碼、請走 /api/me/change-password',
        });
      }

      // Scenario 5: target not found.
      const targetRes = await query(
        'SELECT id, email, name, role FROM users WHERE id = $1',
        [targetId]
      );
      if (targetRes.rows.length === 0) {
        return res.status(404).json({ error: '找不到指定使用者' });
      }
      const target = targetRes.rows[0];

      // Scenario 3: admin can only reset users.
      if (!isAtLeast(actorRole, 'super_admin') && target.role !== 'user') {
        return res.status(403).json({
          error: 'admin 只能重設 user 角色帳號、不能重設其他 admin 或 super_admin',
        });
      }

      const tempPassword = generateRandomPassword();
      const hash = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS);

      await query(
        `UPDATE users
           SET password_hash = $1,
               must_change_password = TRUE,
               updated_by = $2,
               updated_at = NOW()
         WHERE id = $3`,
        [hash, actorId, targetId]
      );

      try {
        await query(
          `INSERT INTO audit_logs (actor_id, action, target_type, target_id, details)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            actorId,
            'reset_password_by_admin',
            'user',
            targetId,
            JSON.stringify({
              target_email: target.email,
              target_role: target.role,
            }),
          ]
        );
      } catch (auditErr) {
        // Audit failure does not block the success response (existing style).
        logger.warn?.('reset_password audit_log write failed', { error: auditErr.message });
      }

      res.json({
        id: target.id,
        email: target.email,
        name: target.name,
        temporary_password: tempPassword,
        must_change_password: true,
      });
    } catch (err) {
      logger.error?.('reset password failed', { error: err.message });
      res.status(500).json({ error: 'Failed to reset password' });
    }
  });

  return router;
}

// Default export for the production app.js.
export default createAdminPasswordResetRouter();
