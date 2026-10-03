/**
 * task-claim-expiry.js — hand back task cards whose claim is older than a day (v1.31.3),
 * daily at 03:20 Asia/Taipei.
 *
 * A session that died mid-card would otherwise hold it forever. The note appended to the
 * card's body says it expired and who held it, so the next holder knows.
 */

import cron from 'node-cron';
import { query as defaultQuery } from '../utils/db.js';
import logger from '../utils/logger.js';
import { expireStaleClaims } from '../routes/tasks.js';

export async function runTaskClaimExpiry({ query = defaultQuery } = {}) {
  const r = await expireStaleClaims({ query });
  logger.info('task claim expiry finished', { expired: r.expired.length });
  return r;
}

export function startTaskClaimExpiryJob() {
  cron.schedule('20 3 * * *', () => {
    runTaskClaimExpiry().catch((err) =>
      logger.error('task claim expiry cron failed', { error: err.message }));
  }, { timezone: 'Asia/Taipei' });
  logger.info('task claim expiry job started (daily 03:20 Asia/Taipei)');
}
