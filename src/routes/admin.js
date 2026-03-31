import { Router } from 'express';
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import { query } from '../utils/db.js';
import adminAuth, { superAdminAuth, isAtLeast } from '../middleware/adminAuth.js';
import logger from '../utils/logger.js';

const router = Router();
const BCRYPT_ROUNDS = 10;

async function writeAuditLog(actorId, action, targetType, targetId, details) {
  try {
    await query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorId, action, targetType, targetId, JSON.stringify(details)]
    );
  } catch (err) {
    logger.error('audit_log 寫入失敗', { error: err.message });
  }
}

/**
 * POST /login — Admin 帳密登入（無需 auth middleware）
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

    // 首次設定密碼流程
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
    logger.error('登入失敗', { error: err.message });
    res.status(500).json({ error: '登入失敗' });
  }
});

/**
 * POST /setup — 首次設定 super_admin 密碼（無需 auth，一次性）
 */
router.post('/setup', async (req, res) => {
  try {
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
    logger.error('設定密碼失敗', { error: err.message });
    res.status(500).json({ error: '設定密碼失敗' });
  }
});

// ─── 以下路由需要 admin 認證 ───────────────────────────────────────

router.use(adminAuth);

/**
 * GET /users — 列出所有使用者
 */
router.get('/users', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, name, email, role, api_key, created_at, updated_at FROM users ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('列出使用者失敗', { error: err.message });
    res.status(500).json({ error: '查詢失敗' });
  }
});

/**
 * POST /users — 建立使用者
 * - admin 只能建 role='user'
 * - super_admin 可建任何角色（含密碼）
 */
router.post('/users', async (req, res) => {
  try {
    const { email, name, role, password } = req.body;
    const actorRole = req.user.role;
    const actorId = req.user.id;

    if (!email) {
      return res.status(400).json({ error: '必填欄位：email' });
    }

    const targetRole = role || 'user';

    // admin 只能建 user
    if (!isAtLeast(actorRole, 'super_admin') && targetRole !== 'user') {
      return res.status(403).json({ error: '管理員只能建立 User 角色帳號' });
    }

    // admin/super_admin 角色必須設定密碼
    if (isAtLeast(targetRole, 'admin') && !password) {
      return res.status(400).json({ error: 'admin/super_admin 角色必須設定密碼' });
    }

    const apiKey = randomUUID();
    let passwordHash = null;
    if (password) {
      passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    }

    const result = await query(
      `INSERT INTO users (name, email, role, api_key, password_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, email, role, api_key, created_at`,
      [name || null, email, targetRole, apiKey, passwordHash, actorId]
    );

    const newUser = result.rows[0];
    await writeAuditLog(actorId, 'create_user', 'user', newUser.id, {
      email: newUser.email, role: newUser.role
    });

    res.status(201).json(newUser);
  } catch (err) {
    logger.error('建立使用者失敗', { error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'Email 已存在' });
    res.status(500).json({ error: '建立使用者失敗' });
  }
});

/**
 * PUT /users/:id — 更新使用者 (name, email, role)
 * - 角色變更只有 super_admin 能做
 * - 不能改自己的角色
 * - 降級 super_admin 前確認至少還有一個 super_admin
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

    // admin 不能修改 super_admin 的任何欄位
    if (!isAtLeast(actorRole, 'super_admin') && target.role === 'super_admin') {
      return res.status(403).json({ error: '不能修改超級管理員的資料' });
    }

    // 角色變更：只有 super_admin 能做
    if (role && role !== target.role) {
      if (!isAtLeast(actorRole, 'super_admin')) {
        return res.status(403).json({ error: '只有超級管理員可以變更角色' });
      }
      // 不能改自己的角色
      if (actorId === targetId) {
        return res.status(400).json({ error: '不能修改自己的角色' });
      }
      // 降級 super_admin 前確認至少還有一個
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
    logger.error('更新使用者失敗', { error: err.message });
    res.status(500).json({ error: '更新使用者失敗' });
  }
});

/**
 * DELETE /users/:id — 刪除使用者
 * - 只有 super_admin 能刪
 * - 不能刪自己、不能刪 ID=1
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

    // 先刪除，再寫 audit log（避免刪除失敗但 audit 已記錄）
    await query('DELETE FROM users WHERE id = $1', [targetId]);

    await writeAuditLog(actorId, 'delete_user', 'user', targetId, {
      email: target.email, name: target.name
    });

    res.json({ message: '使用者已刪除', user: target });
  } catch (err) {
    logger.error('刪除使用者失敗', { error: err.message });
    res.status(500).json({ error: '刪除使用者失敗' });
  }
});

/**
 * POST /users/:id/password — 修改密碼
 * - super_admin：可改任何 admin 的密碼（不需舊密碼）
 * - admin：只能改自己的（需要 oldPassword）
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

    // admin 只能改自己的密碼
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

    // super_admin 改他人不需要舊密碼；改自己或 admin 改自己需要驗證
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
    logger.error('修改密碼失敗', { error: err.message });
    res.status(500).json({ error: '修改密碼失敗' });
  }
});

export default router;
