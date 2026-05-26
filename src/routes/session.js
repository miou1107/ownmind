import { Router } from 'express';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';
import { SESSION_RETENTION_DAYS } from '../constants.js';
import { computePeriodRange, computeReportData } from '../utils/report.js';
import { buildSessionRecentQuery } from '../lib/session-query.js';
import { requireFields } from '../utils/require-fields.js';

const router = Router();
router.use(auth);

function sanitize(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text;
  // Redact entire password / token field values.
  result = result.replace(/(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, (match) => {
    const sep = match.includes('=') ? '=' : ':';
    const key = match.split(/[:=]/)[0];
    return `${key}${sep}[REDACTED]`;
  });
  // Bearer token.
  result = result.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  return result;
}

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') return details;
  const clean = { ...details };
  // Sanitize friction_points and suggestions (may contain sensitive commands).
  if (clean.friction_points) clean.friction_points = sanitize(clean.friction_points);
  if (clean.suggestions) clean.suggestions = sanitize(clean.suggestions);
  return clean;
}

/**
 * POST / - record a session.
 */
router.post('/', async (req, res) => {
  try {
    const validation = requireFields(req.body, ['tool', 'model', 'summary']);
    if (validation) return res.status(400).json(validation);

    const { session_id, tool, model, machine, details } = req.body;
    let { summary } = req.body;

    // Sanitize sensitive content.
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
    logger.error('session log failed', { error: err.message });
    res.status(500).json({ error: 'Failed to record session' });
  }
});

/**
 * GET /recent - fetch recent sessions.
 * ?days=7                   - last N days (default 7)
 * ?tool=cursor              - filter by tool
 * ?include_compressed=true  - include monthly summaries
 * ?q=keyword                - v1.17.13 ILIKE search over summary + details (Michelle case)
 */
router.get('/recent', async (req, res) => {
  try {
    const { text, values } = buildSessionRecentQuery({
      userId: req.user.id,
      days: parseInt(req.query.days) || 7,
      tool: req.query.tool || null,
      includeCompressed: req.query.include_compressed === 'true',
      q: req.query.q || null,
    });
    const result = await query(text, values);
    res.json(result.rows);
  } catch (err) {
    logger.error('recent session query failed', { error: err.message });
    res.status(500).json({ error: 'Query failed' });
  }
});

/**
 * Compress session_logs older than SESSION_RETENTION_DAYS.
 * Same-month entries merge into a single monthly summary; originals removed.
 * Called asynchronously without blocking the main flow.
 */
export async function compressOldSessions(userId) {
  try {
    // Find uncompressed session_logs older than the retention window,
    // grouped by month.
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

    // Group by month.
    const byMonth = {};
    for (const row of oldSessions.rows) {
      if (!byMonth[row.month]) byMonth[row.month] = [];
      byMonth[row.month].push(row);
    }

    for (const [month, sessions] of Object.entries(byMonth)) {
      const lines = sessions.map(s => `- [${s.tool}] ${s.summary}`);
      const summary = `月摘要 — ${month}（${sessions.length} sessions）\n\n${lines.join('\n')}`;
      const ids = sessions.map(s => s.id);

      // Use a transaction to prevent race conditions.
      await query('BEGIN');
      try {
        // Lock the rows we plan to delete, preventing concurrent compression.
        const locked = await query(
          `SELECT id FROM session_logs WHERE id = ANY($1) FOR UPDATE SKIP LOCKED`,
          [ids]
        );
        if (locked.rows.length === 0) {
          await query('ROLLBACK');
          continue; // already handled by another process
        }

        await query(
          `INSERT INTO session_logs (user_id, tool, model, summary, compressed, compressed_at, created_at)
           VALUES ($1, 'summary', 'compressed', $2, true, NOW(), $3)`,
          [userId, summary, `${month}-01T00:00:00Z`]
        );
        await query(`DELETE FROM session_logs WHERE id = ANY($1)`, [ids]);
        await query('COMMIT');
        logger.info(`session logs compressed: ${month}, ${sessions.length} rows → 1 monthly summary`, { userId });
      } catch (txErr) {
        await query('ROLLBACK');
        logger.error(`compress transaction failed: ${month}`, { error: txErr.message, userId });
      }
    }
  } catch (err) {
    logger.error('compress session logs failed', { error: err.message, userId });
  }
}

/**
 * GET /report - weekly / monthly report.
 * Query: period=week|month, offset=0,1,2...
 */
router.get('/report', async (req, res) => {
  try {
    const period = req.query.period;
    const offset = parseInt(req.query.offset, 10) || 0;

    if (!['week', 'month'].includes(period)) {
      return res.status(400).json({ error: 'period must be either week or month' });
    }
    if (offset < 0 || offset > 52) {
      return res.status(400).json({ error: 'offset must be between 0 and 52' });
    }

    const { start, end, label } = computePeriodRange(period, offset);

    // Query session logs in the period (with friction / suggestions).
    const sessions = await query(
      `SELECT tool, model, details FROM session_logs
       WHERE user_id = $1
         AND created_at >= $2
         AND created_at <= $3
         AND details IS NOT NULL AND details != '{}'::jsonb
         AND compressed = false`,
      [req.user.id, start, end]
    );

    // Count new memories (excluding pending_review).
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

    // Count auto-created friction issues in the period.
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
    logger.error('week/month report failed', { error: err.message });
    res.status(500).json({ error: 'Query failed' });
  }
});

export default router;
