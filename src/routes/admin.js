import { Router } from 'express';
import { randomUUID } from 'crypto';
import { query } from '../utils/db.js';
import adminAuth from '../middleware/adminAuth.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(adminAuth);

/**
 * GET /users - 列出所有使用者
 */
router.get('/users', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, username, email, role, created_at, updated_at FROM users ORDER BY created_at DESC'
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

    if (!email || !name) {
      return res.status(400).json({ error: '必填欄位：email, name' });
    }

    const apiKey = randomUUID();

    const result = await query(
      `INSERT INTO users (username, email, role, api_key)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, role, api_key, created_at`,
      [name, email, role || 'user', apiKey]
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
       SET username = COALESCE($1, username),
           email = COALESCE($2, email),
           role = COALESCE($3, role),
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, username, email, role, created_at, updated_at`,
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
 * DELETE /users/:id - 停用使用者（軟刪除）
 */
router.delete('/users/:id', async (req, res) => {
  try {
    const result = await query(
      `DELETE FROM users WHERE id = $1 RETURNING id, username, email`,
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
