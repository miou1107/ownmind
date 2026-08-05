import { Router } from 'express';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';
import { SESSION_RETENTION_DAYS } from '../constants.js';
import { computePeriodRange, computeReportData } from '../utils/report.js';
import { buildSessionRecentQuery } from '../lib/session-query.js';
import { requireFields } from '../utils/require-fields.js';
import { bucketLabel } from '../utils/session-buckets.js';

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
    // v1.26.61: only `summary` is required. `tool` is defaulted by the MCP client from
    // the tool hosting it, and `model` is genuinely optional — nothing in the client
    // knows it, and requiring it discarded the entire session record to protect one
    // string. Both columns have always been nullable (db/001_init.sql:65-66); this makes
    // the endpoint agree with its own schema. See Eric's bug #9.
    const validation = requireFields(req.body, ['summary']);
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
 * ?q=keyword                - v1.17.13 ILIKE search over summary + details (Dana case)
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
      // v1.26.61: bucketLabel, not the raw column. `tool` became nullable for direct API
      // callers in this release, and a template literal turns a NULL into the four
      // characters "null" — permanently, because this text replaces the rows it
      // summarises and they are then deleted.
      const lines = sessions.map(s => `- [${bucketLabel(s.tool)}] ${s.summary}`);
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

    // Count both kinds of auto-created memory in one pass. They are two cards side
    // by side reading "created in this period", so they must be counted the same
    // way; two queries drifting apart is how the suggestion card ended up with no
    // query at all. Both are written by src/jobs/weeklyReport.js.
    //
    // Note what the number means: the weekly job runs on Monday for the *previous*
    // week, so a creation lands in the window after the one that produced it. This
    // is an honest count of creations during the period, not an attribution of the
    // period's own frictions. The page says which. Attributing them back would need
    // a period stamp the memories do not carry.
    const autoCreatedResult = await query(
      `SELECT
         COUNT(*) FILTER (WHERE tags @> ARRAY['friction-issue', 'auto-generated']) AS frictions,
         COUNT(*) FILTER (WHERE tags @> ARRAY['suggestion-action', 'auto-generated']) AS suggestions
       FROM memories
       WHERE user_id = $1
         AND created_at >= $2
         AND created_at <= $3`,
      [req.user.id, start, end]
    );

    // Two counts, because an empty friction list has more than one innocent cause.
    //
    // `live` is every uncompressed row, whether or not it carried `details`, which is
    // what separates "no session was logged" from "sessions were logged but carried no
    // reflection fields".
    //
    // `compressed` is counted separately rather than folded into the total. Found in
    // adversarial review: compressOldSessions replaces a month of sessions with one
    // summary row carrying no `details`, stamped at the 1st of that month. Counting it
    // as a live row made the page report a reporting gap — "records exist but nobody
    // filled the fields in" — when the truth is the reverse, that the notes existed and
    // retention discarded them.
    const sessionCountsResult = await query(
      `SELECT
         COUNT(*) FILTER (WHERE compressed = false) AS live,
         COUNT(*) FILTER (WHERE compressed = true) AS compressed
       FROM session_logs
       WHERE user_id = $1
         AND created_at >= $2
         AND created_at <= $3`,
      [req.user.id, start, end]
    );

    const report = computeReportData(sessions.rows, newMemoriesCount, label);
    report.friction_issues_created = parseInt(autoCreatedResult.rows[0].frictions, 10);
    report.suggestion_actions_created = parseInt(autoCreatedResult.rows[0].suggestions, 10);
    report.sessions_total = parseInt(sessionCountsResult.rows[0].live, 10);
    report.sessions_compressed = parseInt(sessionCountsResult.rows[0].compressed, 10);
    report.period_start = start.toISOString();
    report.period_end = end.toISOString();
    // Session detail older than this is not hidden, it is deleted: compressOldSessions
    // merges those rows into one monthly summary carrying no `details` and drops the
    // originals. 月報 + 三期前 reaches 60 to 120 days back, so the UI can ask for a
    // window the data no longer covers, and has to say so.
    report.detail_retention_cutoff =
      new Date(Date.now() - SESSION_RETENTION_DAYS * 86400000).toISOString();

    res.json(report);
  } catch (err) {
    logger.error('week/month report failed', { error: err.message });
    res.status(500).json({ error: 'Query failed' });
  }
});

export default router;
