import { Router } from 'express';
import { query as defaultQuery } from '../../utils/db.js';
import defaultAuth from '../../middleware/auth.js';
import logger from '../../utils/logger.js';

/**
 * GET /api/usage/stats
 *
 * Query params:
 *   from=YYYY-MM-DD  (default: 30 days ago)
 *   to=YYYY-MM-DD    (default: today)
 *   group_by=day|tool|model|session  (default: day)
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
        return res.status(400).json({ error: 'group_by must be one of day/tool/model/session' });
      }

      // Decide which user's stats to query:
      //   - default: req.user.id (themselves)
      //   - admin+ can pass ?user_id=N to inspect someone else (dashboard
      //     "team usage" clicks a member to expand)
      //   - regular user passing ?user_id of someone else → 403
      let userId = req.user.id;
      if (req.query.user_id != null && req.query.user_id !== '') {
        const requested = parseInt(req.query.user_id, 10);
        if (!Number.isFinite(requested)) {
          return res.status(400).json({ error: 'user_id must be an integer' });
        }
        if (requested !== req.user.id) {
          if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Only admin or above may inspect another user\'s usage' });
          }
        }
        userId = requested;
      }

      // Fetch the target user's name / email (for dashboard display).
      const target = userId === req.user.id
        ? { id: req.user.id, name: req.user.name, email: req.user.email }
        : await loadUserBasics({ query }, userId);
      if (!target) return res.status(404).json({ error: 'User not found' });

      const totals = await loadTotals({ query }, userId, from, to);
      const series = await loadSeries({ query }, userId, from, to, groupBy);
      // is_exempt: used by the dashboard status indicator (D3 alignment —
      // exempt users may have historical data but the current ingestion
      // is suppressed; the UI must report the real status).
      const isExempt = await isUserExempt({ query }, userId);

      res.json({
        user: target,
        period: { from, to },
        totals,
        series,
        is_exempt: isExempt
      });
    } catch (err) {
      logger.error('usage stats query failed', { error: err.message });
      res.status(500).json({ error: 'Failed to query usage' });
    }
  });

  return router;
}

// ────────────────────────────────────────────────────────────
// Helpers (pure, testable)
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

async function loadUserBasics({ query }, userId) {
  const r = await query(
    `SELECT id, name, email FROM users WHERE id = $1 LIMIT 1`, [userId]
  );
  return r.rows[0] || null;
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
  // Tier 1: token_usage_daily (with tokens + cost).
  // cost_usd null policy: SUM skips NULL rows, and combined with COALESCE
  // this would "hide" partial-NULL days behind a complete-looking number.
  // Use bool_or(IS NULL) to detect any NULL → in that case the whole
  // cost_usd response is null (aligned with buildDailyRow's policy).
  const tier1 = await query(
    `SELECT
       CASE WHEN bool_or(cost_usd IS NULL) THEN NULL
            ELSE COALESCE(SUM(cost_usd), 0)::float END AS cost_usd,
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
  // Tier 2: session_count (Cursor / Antigravity — only count + wall_seconds).
  const tier2 = await query(
    `SELECT COALESCE(SUM(count), 0)::int AS tier2_sessions,
            COALESCE(SUM(wall_seconds), 0)::int AS tier2_wall_seconds
       FROM session_count
      WHERE user_id = $1 AND date >= $2 AND date <= $3`,
    [userId, from, to]
  );
  const t1 = tier1.rows[0] ?? emptyTotals();
  const t2 = tier2.rows[0] ?? { tier2_sessions: 0, tier2_wall_seconds: 0 };
  return {
    ...t1,
    session_count: Number(t1.session_count || 0) + Number(t2.tier2_sessions || 0),
    wall_seconds: Number(t1.wall_seconds || 0) + Number(t2.tier2_wall_seconds || 0)
  };
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
  // cost_usd null-on-any-null policy (aligned with buildDailyRow).
  const res = await query(
    `SELECT ${selectKey} AS key,
            CASE WHEN bool_or(cost_usd IS NULL) THEN NULL
                 ELSE SUM(cost_usd)::float END AS cost_usd,
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
  const tier1Rows = res.rows;

  // Tier 2 merge: only meaningful for day / tool group_by.
  //   - model / session: Tier 2 has no such concept, skip.
  if (groupBy !== 'day' && groupBy !== 'tool') return tier1Rows;

  const t2Res = groupBy === 'day'
    ? await query(
        `SELECT TO_CHAR(date, 'YYYY-MM-DD') AS key,
                SUM(count)::int AS session_count,
                SUM(wall_seconds)::int AS wall_seconds
           FROM session_count
          WHERE user_id = $1 AND date >= $2 AND date <= $3
          GROUP BY date ORDER BY date ASC`,
        [userId, from, to]
      )
    : await query(
        `SELECT tool AS key,
                SUM(count)::int AS session_count,
                SUM(wall_seconds)::int AS wall_seconds
           FROM session_count
          WHERE user_id = $1 AND date >= $2 AND date <= $3
          GROUP BY tool ORDER BY tool ASC`,
        [userId, from, to]
      );

  // Merge: same key accumulates wall_seconds, adds the session_count field.
  const byKey = new Map();
  for (const r of tier1Rows) byKey.set(String(r.key), { ...r, session_count: Number(r.message_count || 0) });
  for (const r of t2Res.rows) {
    const k = String(r.key);
    if (byKey.has(k)) {
      const existing = byKey.get(k);
      existing.wall_seconds = Number(existing.wall_seconds || 0) + Number(r.wall_seconds || 0);
      existing.session_count = Number(existing.session_count || 0) + Number(r.session_count || 0);
    } else {
      // Tier 2-only keys: fill tokens / cost with zeros.
      byKey.set(k, {
        key: k,
        cost_usd: 0,
        input_tokens: 0, output_tokens: 0,
        cache_creation_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0,
        message_count: 0,
        wall_seconds: Number(r.wall_seconds || 0),
        active_seconds: 0,
        session_count: Number(r.session_count || 0)
      });
    }
  }
  return [...byKey.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
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
