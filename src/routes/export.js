import { Router } from 'express';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(auth);

/**
 * GET / - export all memories as JSON.
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

    // Group by type.
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
    logger.error('memory export failed', { error: err.message });
    res.status(500).json({ error: 'Export failed' });
  }
});

export default router;
