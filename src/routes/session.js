import { Router } from 'express';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';
import { SESSION_RETENTION_DAYS } from '../constants.js';
import { computePeriodRange, computeReportData } from '../utils/report.js';

const router = Router();
router.use(auth);

function sanitize(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text;
  // 密碼/token 欄位整體遮蔽
  result = result.replace(/(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, (match) => {
    const sep = match.includes('=') ? '=' : ':';
    const key = match.split(/[:=]/)[0];
    return `${key}${sep}[REDACTED]`;
  });
  // Bearer token
  result = result.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  return result;
}

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') return details;
  const clean = { ...details };
  // 過濾 friction_points 和 suggestions（可能包含敏感指令）
  if (clean.friction_points) clean.friction_points = sanitize(clean.friction_points);
  if (clean.suggestions) clean.suggestions = sanitize(clean.suggestions);
  return clean;
}

/**
 * POST / - 記錄 session
 */
router.post('/', async (req, res) => {
  try {
    const { session_id, tool, model, machine, details } = req.body;
    let { summary } = req.body;

    if (!tool || !model || !summary) {
      return res.status(400).json({ error: '必填欄位：tool, model, summary' });
    }

    // 過濾敏感資訊
    summary = sanitize(summary);
    const cleanDetails = sanitizeDetails(details);

    const result = await query(
      `INSERT INTO session_logs (user_id, session_id, tool, model, machine, summary, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.id, session_id || null, tool, model, machine || null, summary, cleanDetails || null]
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
      const lines = sessions.map(s => `- [${s.tool}] ${s.summary}`);
      const summary = `月摘要 — ${month}（${sessions.length} sessions）\n\n${lines.join('\n')}`;
      const ids = sessions.map(s => s.id);

      // 用 transaction 防止 race condition
      await query('BEGIN');
      try {
        // 鎖定要刪除的 rows，防止並發壓縮
        const locked = await query(
          `SELECT id FROM session_logs WHERE id = ANY($1) FOR UPDATE SKIP LOCKED`,
          [ids]
        );
        if (locked.rows.length === 0) {
          await query('ROLLBACK');
          continue; // 已被其他 process 處理
        }

        await query(
          `INSERT INTO session_logs (user_id, tool, model, summary, compressed, compressed_at, created_at)
           VALUES ($1, 'summary', 'compressed', $2, true, NOW(), $3)`,
          [userId, summary, `${month}-01T00:00:00Z`]
        );
        await query(`DELETE FROM session_logs WHERE id = ANY($1)`, [ids]);
        await query('COMMIT');
        logger.info(`壓縮 session logs: ${month}, ${sessions.length} 筆 → 1 筆月摘要`, { userId });
      } catch (txErr) {
        await query('ROLLBACK');
        logger.error(`壓縮 transaction 失敗: ${month}`, { error: txErr.message, userId });
      }
    }
  } catch (err) {
    logger.error('壓縮 session logs 失敗', { error: err.message, userId });
  }
}

/**
 * GET /report - 取週/月報
 * Query: period=week|month, offset=0,1,2...
 */
router.get('/report', async (req, res) => {
  try {
    const period = req.query.period;
    const offset = parseInt(req.query.offset, 10) || 0;

    if (!['week', 'month'].includes(period)) {
      return res.status(400).json({ error: 'period 必須是 week 或 month' });
    }
    if (offset < 0 || offset > 52) {
      return res.status(400).json({ error: 'offset 範圍 0~52' });
    }

    const { start, end, label } = computePeriodRange(period, offset);

    // 查詢該 period 的 session logs（含 friction/suggestions）
    const sessions = await query(
      `SELECT tool, model, details FROM session_logs
       WHERE user_id = $1
         AND created_at >= $2
         AND created_at <= $3
         AND details IS NOT NULL AND details != '{}'::jsonb
         AND compressed = false`,
      [req.user.id, start, end]
    );

    // 查詢新增記憶數（排除 pending_review）
    const memoriesResult = await query(
      `SELECT COUNT(*) as cnt FROM memories
       WHERE user_id = $1
         AND created_at >= $2
         AND created_at <= $3
         AND status = 'active'
         AND NOT (tags @> ARRAY['pending_review'])`,
      [req.user.id, start, end]
    );
    const newMemoriesCount = parseInt(memoriesResult.rows[0].cnt, 10);

    // 查詢該 period 自動建立的 friction issue 數
    const frictionIssuesResult = await query(
      `SELECT COUNT(*) as cnt FROM memories
       WHERE user_id = $1
         AND created_at >= $2
         AND created_at <= $3
         AND tags @> ARRAY['friction-issue', 'auto-generated']`,
      [req.user.id, start, end]
    );
    const frictionIssuesCreated = parseInt(frictionIssuesResult.rows[0].cnt, 10);

    const report = computeReportData(sessions.rows, newMemoriesCount, label);
    report.friction_issues_created = frictionIssuesCreated;

    res.json(report);
  } catch (err) {
    logger.error('取週/月報失敗', { error: err.message });
    res.status(500).json({ error: '查詢失敗' });
  }
});

export default router;
