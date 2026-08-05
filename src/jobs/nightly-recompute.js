/**
 * nightly-recompute.js — full recompute run daily at 3:00 AM Asia/Taipei
 *
 * Purpose (per spec S3):
 *   - v1.26.60: no longer recomputes cost; pricing was removed (Requirement 8)
 *   - patch up missed computations caused by aggregation failures
 *
 * Scope: the last 7 days (adjustable via WINDOW_DAYS)
 */

import cron from 'node-cron';
import { query as defaultQuery } from '../utils/db.js';
import { recomputeDaily } from './usage-aggregation.js';
import logger from '../utils/logger.js';

const WINDOW_DAYS = 7;

/**
 * Pick the (user, tool, session, date) combos with token_events activity in the last
 * WINDOW_DAYS and re-run recomputeDaily for each combo.
 */
export async function runNightlyRecompute({ query = defaultQuery } = {}) {
  logger.info('nightly token usage recompute started', { window_days: WINDOW_DAYS });

  const res = await query(
    `SELECT user_id, tool, session_id,
            (ts AT TIME ZONE 'Asia/Taipei')::date AS date
       FROM token_events
      WHERE ts >= NOW() - ($1 || ' days')::interval
      GROUP BY user_id, tool, session_id, date
      ORDER BY date ASC`,
    [String(WINDOW_DAYS)]
  );

  let ok = 0;
  let fail = 0;
  for (const r of res.rows) {
    try {
      await recomputeDaily({ query }, {
        userId: r.user_id, tool: r.tool, sessionId: r.session_id,
        date: r.date instanceof Date ? toYmd(r.date) : r.date
      });
      ok += 1;
    } catch (err) {
      fail += 1;
      logger.error('nightly recompute failed for one row', {
        user_id: r.user_id, tool: r.tool, session_id: r.session_id, error: err.message
      });
    }
  }

  logger.info('nightly recompute finished', { ok, fail, total: res.rows.length });
  return { ok, fail, total: res.rows.length };
}

export function startNightlyRecomputeJob() {
  cron.schedule('0 3 * * *', () => {
    runNightlyRecompute().catch((err) =>
      logger.error('nightly recompute cron failed', { error: err.message }));
  }, { timezone: 'Asia/Taipei' });

  logger.info('nightly token usage recompute job started (daily 03:00 Asia/Taipei)');
}

function toYmd(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(date);
}
