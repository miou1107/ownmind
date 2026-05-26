import { Router } from 'express';
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import { query } from '../utils/db.js';
import adminAuth, { superAdminAuth, isAtLeast } from '../middleware/adminAuth.js';
import logger from '../utils/logger.js';
import { generateRandomPassword } from '../../shared/random-password.js';
import { requireFields } from '../utils/require-fields.js';

const router = Router();
const BCRYPT_ROUNDS = 10;
// v1.19.10: the fixed default password 'Password42760988' was removed
// (leaked when the repo went public). Each new user now gets a random
// password; admin sees it once and nothing fixed remains in code.
// See openspec/changes/v1.19.10-secret-leak-hotfix/proposal.md.

async function writeAuditLog(actorId, action, targetType, targetId, details) {
  try {
    await query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorId, action, targetType, targetId, JSON.stringify(details)]
    );
  } catch (err) {
    logger.error('audit_log write failed', { error: err.message });
  }
}

/**
 * POST /login — admin email/password login (no auth middleware).
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: '請輸入 Email 和密碼' });
    }

    const result = await query(
      `SELECT id, email, name, role, api_key, password_hash
       FROM users WHERE email = $1 AND role IN ('admin', 'super_admin')`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }

    const user = result.rows[0];

    // First-time password setup flow.
    if (!user.password_hash) {
      return res.status(200).json({ requiresSetup: true });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }

    await writeAuditLog(user.id, 'login', 'user', user.id, { email: user.email });

    res.json({ id: user.id, api_key: user.api_key, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    logger.error('login failed', { error: err.message });
    res.status(500).json({ error: '登入失敗' });
  }
});

/**
 * POST /setup — set the super_admin password for the first time
 * (requires SETUP_TOKEN; one-shot).
 */
router.post('/setup', async (req, res) => {
  try {
    const setupToken = process.env.SETUP_TOKEN;
    if (!setupToken) {
      return res.status(403).json({ error: '/setup 端點已停用（伺服器未設定 SETUP_TOKEN）' });
    }
    if (req.body.setup_token !== setupToken) {
      return res.status(403).json({ error: 'SETUP_TOKEN 不正確' });
    }

    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: '請輸入 Email 和密碼' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: '密碼至少 8 個字元' });
    }

    const result = await query(
      `SELECT id, email, name, role, api_key FROM users
       WHERE email = $1 AND role = 'super_admin' AND password_hash IS NULL`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: '找不到待設定帳號，或密碼已設定' });
    }

    const user = result.rows[0];
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    await query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [hash, user.id]
    );

    await writeAuditLog(user.id, 'setup_password', 'user', user.id, { email: user.email });

    res.json({ id: user.id, api_key: user.api_key, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    logger.error('setup password failed', { error: err.message });
    res.status(500).json({ error: '設定密碼失敗' });
  }
});

// ─── The routes below require admin auth. ───────────────────────────────

router.use(adminAuth);

/**
 * GET /users — list all users.
 */
router.get('/users', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, name, email, role, api_key, created_at, updated_at FROM users ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('list users failed', { error: err.message });
    res.status(500).json({ error: '查詢失敗' });
  }
});

/**
 * POST /users — create a user.
 * - admin can only create role='user'
 * - super_admin can create any role (including password)
 */
router.post('/users', async (req, res) => {
  try {
    const validation = requireFields(req.body, ['email']);
    if (validation) return res.status(400).json(validation);

    const { email, name, role, password } = req.body;
    const actorRole = req.user.role;
    const actorId = req.user.id;

    const targetRole = role || 'user';

    // admin can only create user.
    if (!isAtLeast(actorRole, 'super_admin') && targetRole !== 'user') {
      return res.status(403).json({ error: '管理員只能建立 User 角色帳號' });
    }

    // admin/super_admin role requires a password.
    if (isAtLeast(targetRole, 'admin') && !password) {
      return res.status(400).json({ error: 'admin/super_admin 角色必須設定密碼' });
    }

    const apiKey = randomUUID();
    let passwordHash = null;
    let mustChangePassword = false;
    let generatedPassword = null;
    if (password) {
      // Admin supplied a password explicitly → use it, don't force change.
      passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    } else if (targetRole === 'user') {
      // v1.19.10: generate a random per-user password (replaces the
      // v1.17.26 fixed default 'Password42760988').
      generatedPassword = generateRandomPassword();
      passwordHash = await bcrypt.hash(generatedPassword, BCRYPT_ROUNDS);
      mustChangePassword = true;
    }

    const result = await query(
      `INSERT INTO users (name, email, role, api_key, password_hash, must_change_password, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, email, role, api_key, must_change_password, created_at`,
      [name || null, email, targetRole, apiKey, passwordHash, mustChangePassword, actorId]
    );

    const newUser = result.rows[0];
    await writeAuditLog(actorId, 'create_user', 'user', newUser.id, {
      email: newUser.email, role: newUser.role
    });

    // When the system generated the password (admin did not supply one),
    // return it to the admin exactly once; nothing fixed is persisted.
    if (generatedPassword) {
      newUser.default_password = generatedPassword;
    }
    res.status(201).json(newUser);
  } catch (err) {
    logger.error('create user failed', { error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'Email 已存在' });
    res.status(500).json({ error: '建立使用者失敗' });
  }
});

/**
 * PUT /users/:id — update a user (name, email, role).
 * - role changes require super_admin
 * - cannot change your own role
 * - before demoting a super_admin, ensure at least one remains
 */
router.put('/users/:id', async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const { email, name, role } = req.body;
    const actorId = req.user.id;
    const actorRole = req.user.role;

    const targetRes = await query('SELECT id, name, email, role FROM users WHERE id = $1', [targetId]);
    if (targetRes.rows.length === 0) {
      return res.status(404).json({ error: '找不到該使用者' });
    }
    const target = targetRes.rows[0];

    // admin cannot modify any field on a super_admin.
    if (!isAtLeast(actorRole, 'super_admin') && target.role === 'super_admin') {
      return res.status(403).json({ error: '不能修改超級管理員的資料' });
    }

    // role change: super_admin only.
    if (role && role !== target.role) {
      if (!isAtLeast(actorRole, 'super_admin')) {
        return res.status(403).json({ error: '只有超級管理員可以變更角色' });
      }
      // Cannot change your own role.
      if (actorId === targetId) {
        return res.status(400).json({ error: '不能修改自己的角色' });
      }
      // Before demoting super_admin, ensure at least one super_admin remains.
      if (target.role === 'super_admin' && role !== 'super_admin') {
        const countRes = await query(
          `SELECT COUNT(*) FROM users WHERE role = 'super_admin' AND id != $1`, [targetId]
        );
        if (parseInt(countRes.rows[0].count, 10) < 1) {
          return res.status(400).json({ error: '至少需要保留一個超級管理員' });
        }
      }
    }

    const result = await query(
      `UPDATE users
       SET name = COALESCE($1, name),
           email = COALESCE($2, email),
           role = COALESCE($3, role),
           updated_by = $4,
           updated_at = NOW()
       WHERE id = $5
       RETURNING id, name, email, role, created_at, updated_at`,
      [name || null, email || null, role || null, actorId, targetId]
    );

    await writeAuditLog(actorId, 'update_user', 'user', targetId, {
      changes: { name, email, role }
    });

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('update user failed', { error: err.message });
    res.status(500).json({ error: '更新使用者失敗' });
  }
});

/**
 * DELETE /users/:id — delete a user.
 * - super_admin only
 * - cannot delete yourself; cannot delete ID=1
 */
router.delete('/users/:id', async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const actorId = req.user.id;
    const actorRole = req.user.role;

    if (!isAtLeast(actorRole, 'super_admin')) {
      return res.status(403).json({ error: '只有超級管理員可以刪除使用者' });
    }
    if (targetId === actorId) {
      return res.status(400).json({ error: '不能刪除自己的帳號' });
    }
    if (targetId === 1) {
      return res.status(400).json({ error: '不能刪除主帳號' });
    }

    const targetRes = await query('SELECT id, name, email FROM users WHERE id = $1', [targetId]);
    if (targetRes.rows.length === 0) {
      return res.status(404).json({ error: '找不到該使用者' });
    }
    const target = targetRes.rows[0];

    // Delete first, then write the audit log (avoid the case where deletion
    // failed but audit was already recorded).
    await query('DELETE FROM users WHERE id = $1', [targetId]);

    await writeAuditLog(actorId, 'delete_user', 'user', targetId, {
      email: target.email, name: target.name
    });

    res.json({ message: '使用者已刪除', user: target });
  } catch (err) {
    logger.error('delete user failed', { error: err.message });
    res.status(500).json({ error: '刪除使用者失敗' });
  }
});

/**
 * POST /users/:id/password — change a password.
 * - super_admin: can change any admin's password (no oldPassword needed)
 * - admin: can only change their own (oldPassword required)
 */
router.post('/users/:id/password', async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const { oldPassword, newPassword } = req.body;
    const actorId = req.user.id;
    const actorRole = req.user.role;

    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: '新密碼至少 8 個字元' });
    }

    const isSelf = actorId === targetId;
    const isSuperAdmin = isAtLeast(actorRole, 'super_admin');

    // admin may only change their own password.
    if (!isSuperAdmin && !isSelf) {
      return res.status(403).json({ error: '只能修改自己的密碼' });
    }

    const targetRes = await query(
      'SELECT id, email, role, password_hash FROM users WHERE id = $1', [targetId]
    );
    if (targetRes.rows.length === 0) {
      return res.status(404).json({ error: '找不到該使用者' });
    }
    const target = targetRes.rows[0];

    // super_admin changing someone else does not need oldPassword; changing
    // your own (or admin changing their own) requires verification.
    if (isSelf || !isSuperAdmin) {
      if (!oldPassword) {
        return res.status(400).json({ error: '請輸入舊密碼' });
      }
      if (target.password_hash) {
        const valid = await bcrypt.compare(oldPassword, target.password_hash);
        if (!valid) {
          return res.status(401).json({ error: '舊密碼錯誤' });
        }
      }
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await query(
      `UPDATE users SET password_hash = $1, updated_by = $2, updated_at = NOW() WHERE id = $3`,
      [hash, actorId, targetId]
    );

    await writeAuditLog(actorId, 'change_password', 'user', targetId, {
      target_email: target.email, by_self: isSelf
    });

    res.json({ message: '密碼已更新' });
  } catch (err) {
    logger.error('change password failed', { error: err.message });
    res.status(500).json({ error: '修改密碼失敗' });
  }
});

// v1.19.9: the reset-password endpoint moved to a standalone factory
// module (src/routes/admin-password-reset.js) — easier to inject for tests
// and cleanly separates "forgot-password recovery" from "normal change".

export default router;
