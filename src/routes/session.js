import { Router } from 'express';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';
import { SESSION_RETENTION_DAYS } from '../constants.js';

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
 * ?days=7          - 最近幾天（預設 7）
 * ?tool=cursor     - 按工具過濾
 * ?include_compressed=true - 包含月摘要
 */
router.get('/recent', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const tool = req.query.tool || null;
    const includeCompressed = req.query.include_compressed === 'true';

    let sql = `SELECT * FROM session_logs WHERE user_id = $1`;
    const params = [req.user.id];
    let paramIdx = 2;

    if (!includeCompressed) {
      sql += ` AND compressed = false`;
    }

    sql += ` AND created_at >= NOW() - INTERVAL '1 day' * $${paramIdx}`;
    params.push(days);
    paramIdx++;

    if (tool) {
      sql += ` AND tool = $${paramIdx}`;
      params.push(tool);
      paramIdx++;
    }

    sql += ` ORDER BY created_at DESC`;

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    logger.error('查詢近期 session 失敗', { error: err.message });
    res.status(500).json({ error: '查詢失敗' });
  }
});

/**
 * 壓縮超過 SESSION_RETENTION_DAYS 的 session logs
 * 同月份合併成一筆月摘要，原始記錄刪除
 * 非同步呼叫，不阻塞主流程
 */
export async function compressOldSessions(userId) {
  try {
    // 找出超過保留期限的未壓縮 session logs，按月份分組
    const oldSessions = await query(
      `SELECT id, tool, model, summary, created_at,
              TO_CHAR(created_at, 'YYYY-MM') as month
       FROM session_logs
       WHERE user_id = $1
         AND compressed = false
         AND created_at < NOW() - INTERVAL '1 day' * $2
       ORDER BY created_at`,
      [userId, SESSION_RETENTION_DAYS]
    );

    if (oldSessions.rows.length === 0) return;

    // 按月份分組
    const byMonth = {};
    for (const row of oldSessions.rows) {
      if (!byMonth[row.month]) byMonth[row.month] = [];
      byMonth[row.month].push(row);
    }

    for (const [month, sessions] of Object.entries(byMonth)) {
      // 產生月摘要
      const lines = sessions.map(s => `- [${s.tool}] ${s.summary}`);
      const summary = `月摘要 — ${month}（${sessions.length} sessions）\n\n${lines.join('\n')}`;

      // 插入壓縮後的月摘要
      await query(
        `INSERT INTO session_logs (user_id, tool, model, summary, compressed, compressed_at, created_at)
         VALUES ($1, 'summary', 'compressed', $2, true, NOW(), $3)`,
        [userId, summary, `${month}-01T00:00:00Z`]
      );

      // 刪除原始記錄
      const ids = sessions.map(s => s.id);
      await query(
        `DELETE FROM session_logs WHERE id = ANY($1)`,
        [ids]
      );

      logger.info(`壓縮 session logs: ${month}, ${sessions.length} 筆 → 1 筆月摘要`, { userId });
    }
  } catch (err) {
    logger.error('壓縮 session logs 失敗', { error: err.message, userId });
  }
}

export default router;
