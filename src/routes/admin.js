import { Router } from 'express';
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import { query } from '../utils/db.js';
import adminAuth from '../middleware/adminAuth.js';
import logger from '../utils/logger.js';

const router = Router();

/**
 * POST /login - Admin 帳密登入（不需要 auth middleware）
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: '請輸入 Email 和密碼' });
    }

    const result = await query(
      `SELECT id, email, name, role, api_key, password_hash FROM users WHERE email = $1 AND role = 'admin'`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }

    const user = result.rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ error: '此帳號尚未設定密碼' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }

    res.json({ api_key: user.api_key, name: user.name, email: user.email });
  } catch (err) {
    logger.error('登入失敗', { error: err.message });
    res.status(500).json({ error: '登入失敗' });
  }
});

// 以下路由需要 admin 認證
router.use(adminAuth);

/**
 * GET /users - 列出所有使用者
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
 * POST /users - 建立使用者
 */
router.post('/users', async (req, res) => {
  try {
    const { email, name, role } = req.body;

    if (!email) {
      return res.status(400).json({ error: '必填欄位：email' });
    }

    const apiKey = randomUUID();

    const result = await query(
      `INSERT INTO users (name, email, role, api_key)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, api_key, created_at`,
      [name || null, email, role || 'user', apiKey]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('建立使用者失敗', { error: err.message });
    res.status(500).json({ error: '建立使用者失敗' });
  }
});

/**
 * PUT /users/:id - 更新使用者
 */
router.put('/users/:id', async (req, res) => {
  try {
    const { email, name, role } = req.body;

    const result = await query(
      `UPDATE users
       SET name = COALESCE($1, name),
           email = COALESCE($2, email),
           role = COALESCE($3, role),
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, name, email, role, created_at, updated_at`,
      [name || null, email || null, role || null, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到該使用者' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('更新使用者失敗', { error: err.message });
    res.status(500).json({ error: '更新使用者失敗' });
  }
});

/**
 * DELETE /users/:id - 刪除使用者
 */
router.delete('/users/:id', async (req, res) => {
  try {
    const result = await query(
      `DELETE FROM users WHERE id = $1 RETURNING id, name, email`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到該使用者' });
    }

    res.json({ message: '使用者已刪除', user: result.rows[0] });
  } catch (err) {
    logger.error('刪除使用者失敗', { error: err.message });
    res.status(500).json({ error: '刪除使用者失敗' });
  }
});

export default router;
