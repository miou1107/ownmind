import { Router } from 'express';
import { query } from '../utils/db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(auth);

/**
 * GET / - 列出所有 secret keys（不含值）
 */
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, key, description FROM secrets
       WHERE user_id = $1
       ORDER BY key`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('列出 secrets 失敗', { error: err.message });
    res.status(500).json({ error: '查詢失敗' });
  }
});

/**
 * GET /:key - 取得 secret 值（解密）
 */
router.get('/:key', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, key, encrypted_value, description FROM secrets
       WHERE key = $1 AND user_id = $2`,
      [req.params.key, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到該 secret' });
    }

    const secret = result.rows[0];
    const decryptedValue = decrypt(secret.encrypted_value);

    logger.info('Secret 被存取', { key: req.params.key, user_id: req.user.id });

    res.json({
      id: secret.id,
      key: secret.key,
      value: decryptedValue,
      description: secret.description
    });
  } catch (err) {
    logger.error('取得 secret 失敗', { error: err.message });
    res.status(500).json({ error: '取得 secret 失敗' });
  }
});

/**
 * POST / - 建立 secret
 */
router.post('/', async (req, res) => {
  try {
    const { key, value, description } = req.body;

    if (!key || !value) {
      return res.status(400).json({ error: '必填欄位：key, value' });
    }

    const encryptedValue = encrypt(value);

    const result = await query(
      `INSERT INTO secrets (user_id, key, encrypted_value, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id, key, description`,
      [req.user.id, key, encryptedValue, description || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('建立 secret 失敗', { error: err.message });
    res.status(500).json({ error: '建立 secret 失敗' });
  }
});

/**
 * PUT /:key - 更新 secret
 */
router.put('/:key', async (req, res) => {
  try {
    const { value, description } = req.body;

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (value) {
      updates.push(`encrypted_value = $${paramIndex++}`);
      params.push(encrypt(value));
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      params.push(description);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: '請提供要更新的欄位' });
    }

    updates.push(`updated_at = NOW()`);
    params.push(req.params.key, req.user.id);

    const result = await query(
      `UPDATE secrets
       SET ${updates.join(', ')}
       WHERE key = $${paramIndex++} AND user_id = $${paramIndex}
       RETURNING id, key, description`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到該 secret' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('更新 secret 失敗', { error: err.message });
    res.status(500).json({ error: '更新 secret 失敗' });
  }
});

/**
 * DELETE /:key - 刪除 secret
 */
router.delete('/:key', async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM secrets WHERE key = $1 AND user_id = $2 RETURNING id, key',
      [req.params.key, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到該 secret' });
    }

    res.json({ message: 'Secret 已刪除', key: result.rows[0].key });
  } catch (err) {
    logger.error('刪除 secret 失敗', { error: err.message });
    res.status(500).json({ error: '刪除 secret 失敗' });
  }
});

export default router;
