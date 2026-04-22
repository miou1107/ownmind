import { Router } from 'express';
import { query as defaultQuery } from '../../utils/db.js';
import defaultAuth from '../../middleware/auth.js';
import logger from '../../utils/logger.js';

/**
 * GET /api/usage/stats
 *
 * Query params:
 *   from=YYYY-MM-DD  (預設：30 天前)
 *   to=YYYY-MM-DD    (預設：今天)
 *   group_by=day|tool|model|session  (預設：day)
 *
 * Response:
 *   {
 *     user: { id, name, email },
 *     period: { from, to },
 *     totals: { cost_usd, input_tokens, ..., wall_seconds, active_seconds, message_count },
 *     series: [{ key, cost_usd, ... }]
 *   }
 */
export function createStatsRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const auth = deps.auth ?? defaultAuth;

  const router = Router();

  router.get('/', auth, async (req, res) => {
    try {
      const { from, to, group_by } = parseQueryParams(req.query);
      const groupBy = group_by || 'day';

      if (!['day', 'tool', 'model', 'session'].includes(groupBy)) {
        return res.status(400).json({ error: 'group_by 必須是 day/tool/model/session' });
      }

      const userId = req.user.id;

      const totals = await loadTotals({ query }, userId, from, to);
      const series = await loadSeries({ query }, userId, from, to, groupBy);
      // is_exempt：用於 dashboard 追蹤狀態指示燈（D3 對齊 — 豁免 user 可能有歷史
      // 資料，但目前 ingestion 被 suppressed；UI 必須如實告知狀態）
      const isExempt = await isUserExempt({ query }, userId);

      res.json({
        user: {
          id: req.user.id,
          name: req.user.name,
          email: req.user.email
        },
        period: { from, to },
        totals,
        series,
        is_exempt: isExempt
      });
    } catch (err) {
      logger.error('usage stats 查詢失敗', { error: err.message });
      res.status(500).json({ error: '查詢用量失敗' });
    }
  });

  return router;
}

// ────────────────────────────────────────────────────────────
// Helpers（純函式可測）
// ────────────────────────────────────────────────────────────

export function parseQueryParams(q) {
  const today = new Date();
  const defaultTo = toYmd(today);
  const defaultFrom = toYmd(new Date(today.getTime() - 29 * 86_400_000));

  const from = normalizeYmd(q.from) || defaultFrom;
  const to = normalizeYmd(q.to) || defaultTo;
  return { from, to, group_by: q.group_by };
}

function normalizeYmd(v) {
  if (!v) return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function toYmd(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(date);
}

async function isUserExempt({ query }, userId) {
  const r = await query(
    `SELECT 1 FROM usage_tracking_exemption
      WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1`,
    [userId]
  );
  return r.rows.length > 0;
}

async function loadTotals({ query }, userId, from, to) {
  const res = await query(
    `SELECT
       COALESCE(SUM(cost_usd), 0)::float AS cost_usd,
       COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
       COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
       COALESCE(SUM(cache_creation_tokens), 0)::bigint AS cache_creation_tokens,
       COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens,
       COALESCE(SUM(reasoning_tokens), 0)::bigint AS reasoning_tokens,
       COALESCE(SUM(message_count), 0)::int AS message_count,
       COALESCE(SUM(wall_seconds), 0)::int AS wall_seconds,
       COALESCE(SUM(active_seconds), 0)::int AS active_seconds,
       COUNT(DISTINCT session_id)::int AS session_count
     FROM token_usage_daily
     WHERE user_id = $1 AND date >= $2 AND date <= $3`,
    [userId, from, to]
  );
  return res.rows[0] ?? emptyTotals();
}

function emptyTotals() {
  return {
    cost_usd: 0, input_tokens: 0, output_tokens: 0,
    cache_creation_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0,
    message_count: 0, wall_seconds: 0, active_seconds: 0, session_count: 0
  };
}

async function loadSeries({ query }, userId, from, to, groupBy) {
  const { selectKey, groupClause, orderClause } = buildGrouping(groupBy);
  const res = await query(
    `SELECT ${selectKey} AS key,
            SUM(cost_usd)::float AS cost_usd,
            SUM(input_tokens)::bigint AS input_tokens,
            SUM(output_tokens)::bigint AS output_tokens,
            SUM(cache_creation_tokens)::bigint AS cache_creation_tokens,
            SUM(cache_read_tokens)::bigint AS cache_read_tokens,
            SUM(reasoning_tokens)::bigint AS reasoning_tokens,
            SUM(message_count)::int AS message_count,
            SUM(wall_seconds)::int AS wall_seconds,
            SUM(active_seconds)::int AS active_seconds
       FROM token_usage_daily
      WHERE user_id = $1 AND date >= $2 AND date <= $3
      ${groupClause}
      ${orderClause}`,
    [userId, from, to]
  );
  return res.rows;
}

export function buildGrouping(groupBy) {
  switch (groupBy) {
    case 'tool':
      return { selectKey: 'tool', groupClause: 'GROUP BY tool', orderClause: 'ORDER BY tool ASC' };
    case 'model':
      return { selectKey: 'COALESCE(model, \'unknown\')', groupClause: 'GROUP BY model', orderClause: 'ORDER BY model ASC' };
    case 'session':
      return {
        selectKey: 'session_id',
        groupClause: 'GROUP BY session_id',
        orderClause: 'ORDER BY SUM(cost_usd) DESC NULLS LAST LIMIT 100'
      };
    case 'day':
    default:
      return { selectKey: 'TO_CHAR(date, \'YYYY-MM-DD\')', groupClause: 'GROUP BY date', orderClause: 'ORDER BY date ASC' };
  }
}

export default createStatsRouter();
