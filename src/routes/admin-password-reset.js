/**
 * Admin 緊急重設他人密碼 — v1.19.9
 *
 * 對應 openspec/changes/v1.19.9-password-recovery/spec.md 場景 1-7。
 *
 * 跟既有 POST /api/admin/users/:id/password 的差異：
 *   - 既有 endpoint 是「有意修改」：需要舊密碼、由使用者自選新密碼
 *   - 這個 endpoint 是「忘記救援」：對方忘記密碼、系統產隨機臨時密碼讓他下次強制改
 *
 * 權限：
 *   - super_admin 可重設任何人（admin / user）
 *   - admin 可重設 user（不可重設其他 admin / super_admin）
 *   - 不可重設自己（用 POST /api/me/change-password）
 *
 * 設計：Factory pattern、依賴可注入、方便單元測試。
 */
import { Router } from 'express';
import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import { query as defaultQuery } from '../utils/db.js';
import defaultAdminAuth, { isAtLeast as defaultIsAtLeast } from '../middleware/adminAuth.js';
import defaultLogger from '../utils/logger.js';

const BCRYPT_ROUNDS = 10;
const TEMP_PASSWORD_LEN = 12;

/**
 * 產隨機臨時密碼
 *
 * 規則：
 *   - 12 字、去掉容易混淆的 0/O/I/l/1
 *   - 強制至少 1 大寫 + 1 小寫 + 1 數字
 *   - 用 crypto.randomBytes（不用 Math.random）
 *
 * @param {number} [len=12]
 * @returns {string}
 */
export function generateTempPassword(len = TEMP_PASSWORD_LEN) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去 I / O
  const lower = 'abcdefghjkmnpqrstuvwxyz';   // 去 i / l / o
  const digit = '23456789';                  // 去 0 / 1
  const alphabet = upper + lower + digit;

  const bytes = randomBytes(len);
  const chars = [];
  chars.push(upper[bytes[0] % upper.length]);
  chars.push(lower[bytes[1] % lower.length]);
  chars.push(digit[bytes[2] % digit.length]);
  for (let i = 3; i < len; i++) {
    chars.push(alphabet[bytes[i] % alphabet.length]);
  }

  const shuffleBytes = randomBytes(len);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = shuffleBytes[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * 建立 admin password reset router
 *
 * @param {object} [deps]
 * @param {Function} [deps.query]
 * @param {Function} [deps.adminAuth] - 預設用真實 adminAuth middleware
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

      // 場景 4：不能重設自己
      if (targetId === actorId) {
        return res.status(400).json({
          error: '不能重設自己的密碼、請走 /api/me/change-password',
        });
      }

      // 場景 5：找不到 target
      const targetRes = await query(
        'SELECT id, email, name, role FROM users WHERE id = $1',
        [targetId]
      );
      if (targetRes.rows.length === 0) {
        return res.status(404).json({ error: '找不到指定使用者' });
      }
      const target = targetRes.rows[0];

      // 場景 3：admin 只能重設 user 角色
      if (!isAtLeast(actorRole, 'super_admin') && target.role !== 'user') {
        return res.status(403).json({
          error: 'admin 只能重設 user 角色帳號、不能重設其他 admin 或 super_admin',
        });
      }

      const tempPassword = generateTempPassword();
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
        // audit 失敗不擋成功回應（既有風格）
        logger.warn?.('reset_password audit_log 寫入失敗', { error: auditErr.message });
      }

      res.json({
        id: target.id,
        email: target.email,
        name: target.name,
        temporary_password: tempPassword,
        must_change_password: true,
      });
    } catch (err) {
      logger.error?.('重設密碼失敗', { error: err.message });
      res.status(500).json({ error: '重設密碼失敗' });
    }
  });

  return router;
}

// Default export：給 production app.js 用
export default createAdminPasswordResetRouter();
