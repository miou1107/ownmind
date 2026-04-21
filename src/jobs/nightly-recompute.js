/**
 * nightly-recompute.js — 每日 3:00 AM Asia/Taipei 跑完整 recompute
 *
 * 目的（per spec S3）：
 *   - 處理 pricing 變更後歷史成本重算
 *   - 修補因 aggregation 失敗造成的漏算
 *
 * 範圍：近 7 天（可由 WINDOW_DAYS 調整）
 */

import cron from 'node-cron';
import { query as defaultQuery } from '../utils/db.js';
import { recomputeDaily } from './usage-aggregation.js';
import logger from '../utils/logger.js';

const WINDOW_DAYS = 7;

/**
 * 挑出近 WINDOW_DAYS 有 token_events 活動的 (user, tool, session, date) 組合
 * 並對每個組合重新 recomputeDaily。
 */
export async function runNightlyRecompute({ query = defaultQuery } = {}) {
  logger.info('nightly token usage recompute 開始', { window_days: WINDOW_DAYS });

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
      logger.error('nightly recompute 單筆失敗', {
        user_id: r.user_id, tool: r.tool, session_id: r.session_id, error: err.message
      });
    }
  }

  logger.info('nightly recompute 完成', { ok, fail, total: res.rows.length });
  return { ok, fail, total: res.rows.length };
}

export function startNightlyRecomputeJob() {
  cron.schedule('0 3 * * *', () => {
    runNightlyRecompute().catch((err) =>
      logger.error('nightly recompute cron 失敗', { error: err.message }));
  }, { timezone: 'Asia/Taipei' });

  logger.info('nightly token usage recompute job 已啟動（每日 03:00 Asia/Taipei）');
}

function toYmd(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(date);
}
