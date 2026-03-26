import { Router } from 'express';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(auth);

/**
 * POST / - 記錄 session
 */
router.post('/', async (req, res) => {
  try {
    const { session_id, tool, model, machine, summary, details } = req.body;

    if (!tool || !model || !summary) {
      return res.status(400).json({ error: '必填欄位：tool, model, summary' });
    }

    const result = await query(
      `INSERT INTO session_logs (user_id, session_id, tool, model, machine, summary, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.id, session_id || null, tool, model, machine || null, summary, details || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('記錄 session 失敗', { error: err.message });
    res.status(500).json({ error: '記錄 session 失敗' });
  }
});

/**
 * GET /recent - 取得近期 session
 */
router.get('/recent', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;

    const result = await query(
      `SELECT * FROM session_logs
       WHERE user_id = $1
         AND created_at >= NOW() - INTERVAL '1 day' * $2
       ORDER BY created_at DESC`,
      [req.user.id, days]
    );

    res.json(result.rows);
  } catch (err) {
    logger.error('查詢近期 session 失敗', { error: err.message });
    res.status(500).json({ error: '查詢失敗' });
  }
});

export default router;
