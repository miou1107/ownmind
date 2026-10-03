/**
 * touch-cleanup.js — drop edit touches older than a day (v1.31.2), daily at 03:10 Asia/Taipei.
 *
 * `edit_touches` is a two-hour window, not a record. Every query already ignores old rows;
 * this keeps the table from growing with every edit anyone ever made.
 */

import cron from 'node-cron';
import { query as defaultQuery } from '../utils/db.js';
import logger from '../utils/logger.js';

export const KEEP_HOURS = 24;

export async function runTouchCleanup({ query = defaultQuery } = {}) {
  const res = await query(
    `DELETE FROM edit_touches WHERE last_seen < NOW() - INTERVAL '1 hour' * $1`,
    [KEEP_HOURS],
  );
  logger.info('edit touch cleanup finished', { deleted: res.rowCount ?? 0 });
  return { deleted: res.rowCount ?? 0 };
}

export function startTouchCleanupJob() {
  cron.schedule('10 3 * * *', () => {
    runTouchCleanup().catch((err) =>
      logger.error('edit touch cleanup cron failed', { error: err.message }));
  }, { timezone: 'Asia/Taipei' });
  logger.info('edit touch cleanup job started (daily 03:10 Asia/Taipei)');
}
