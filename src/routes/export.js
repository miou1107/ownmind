import { Router } from 'express';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(auth);

/**
 * GET / - 匯出所有記憶為 JSON
 */
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM memories
       WHERE user_id = $1 AND status = 'active'
       ORDER BY type, created_at`,
      [req.user.id]
    );

    const memories = result.rows;

    // 依類型分組
    const grouped = {};
    for (const memory of memories) {
      if (!grouped[memory.type]) {
        grouped[memory.type] = [];
      }
      grouped[memory.type].push(memory);
    }

    res.json({
      exported_at: new Date().toISOString(),
      user_id: req.user.id,
      total_count: memories.length,
      memories: grouped
    });
  } catch (err) {
    logger.error('匯出記憶失敗', { error: err.message });
    res.status(500).json({ error: '匯出失敗' });
  }
});

export default router;
