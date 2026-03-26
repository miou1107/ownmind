import { Router } from 'express';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(auth);

/**
 * POST / - 建立交接
 */
router.post('/', async (req, res) => {
  try {
    const { project, from_tool, from_model, from_machine, content } = req.body;

    if (!project || !from_tool || !from_model || !content) {
      return res.status(400).json({ error: '必填欄位：project, from_tool, from_model, content' });
    }

    const result = await query(
      `INSERT INTO handoffs (user_id, project, from_tool, from_model, from_machine, content, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
      [req.user.id, project, from_tool, from_model, from_machine || null, content]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('建立交接失敗', { error: err.message });
    res.status(500).json({ error: '建立交接失敗' });
  }
});

/**
 * GET /pending - 取得待處理交接
 */
router.get('/pending', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM handoffs
       WHERE user_id = $1 AND status = 'pending'
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (err) {
    logger.error('查詢待處理交接失敗', { error: err.message });
    res.status(500).json({ error: '查詢失敗' });
  }
});

/**
 * PUT /:id/accept - 接受交接
 */
router.put('/:id/accept', async (req, res) => {
  try {
    const { accepted_by } = req.body;

    if (!accepted_by) {
      return res.status(400).json({ error: '必須提供 accepted_by' });
    }

    const result = await query(
      `UPDATE handoffs
       SET status = 'accepted',
           accepted_by = $1,
           accepted_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [accepted_by, req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到該交接' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('接受交接失敗', { error: err.message });
    res.status(500).json({ error: '接受交接失敗' });
  }
});

export default router;
