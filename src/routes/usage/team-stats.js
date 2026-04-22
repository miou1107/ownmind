import { Router } from 'express';
import { query as defaultQuery } from '../../utils/db.js';
import defaultAdminAuth from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';

/**
 * GET /api/usage/team-stats (admin+)
 *
 * Response（per spec S2）：
 *   {
 *     period: { from, to },
 *     coverage: {
 *       total_users, reporting_today, stale, opted_out,
 *       per_tool: { <tool>: { reporting, stale }, ... }
 *     },
 *     users: [{ user: { id, name, email }, totals: {...} }, ...]
 *   }
 *
 * D5：coverage 強制在 response 露出，dashboard 不達 80% 時加浮水印。
 */
export function createTeamStatsRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const adminAuth = deps.adminAuth ?? defaultAdminAuth;

  const router = Router();

  router.get('/', adminAuth, async (req, res) => {
    try {
      const { from, to } = parseParams(req.query);

      // 1. User 總數 + 活躍 / 停滯 / 豁免
      const coverage = await loadCoverage({ query });

      // 2. User 層聚合（cost / tokens / hours per user）
      const users = await loadUsersAggregate({ query }, from, to);

      res.json({
        period: { from, to },
        coverage,
        users
      });
    } catch (err) {
      logger.error('team-stats 查詢失敗', { error: err.message });
      res.status(500).json({ error: '查詢團隊用量失敗' });
    }
  });

  return router;
}

export function parseParams(q) {
  const today = toYmd(new Date());
  const defaultFrom = toYmd(new Date(Date.now() - 29 * 86_400_000));
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(q?.from)) ? q.from : defaultFrom;
  const to   = /^\d{4}-\d{2}-\d{2}$/.test(String(q?.to))   ? q.to   : today;
  return { from, to };
}

function toYmd(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

async function loadCoverage({ query }) {
  // 活躍 = 24h 內有 heartbeat；stale = 48h+ 無 heartbeat 的 user；exempt = 有豁免
  const res = await query(
    `WITH latest_hb AS (
       SELECT user_id, tool, MAX(last_reported_at) AS last_reported_at
         FROM collector_heartbeat GROUP BY user_id, tool
     ),
     user_status AS (
       SELECT u.id, u.name, u.email,
              MAX(h.last_reported_at) AS latest_any_hb,
              (SELECT 1 FROM usage_tracking_exemption e
                 WHERE e.user_id = u.id
                   AND (e.expires_at IS NULL OR e.expires_at > NOW())
                 LIMIT 1) AS exempt_flag
         FROM users u
         LEFT JOIN latest_hb h ON h.user_id = u.id
        GROUP BY u.id, u.name, u.email
     )
     SELECT id, name, email, latest_any_hb, exempt_flag
       FROM user_status`
  );

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  let reporting_today = 0;
  let stale = 0;
  let opted_out = 0;
  const stale_users = [];
  const exempt_users = [];

  for (const r of res.rows) {
    if (r.exempt_flag) {
      opted_out += 1;
      exempt_users.push({ id: r.id, name: r.name, email: r.email });
      continue;
    }
    if (r.latest_any_hb) {
      const age = now - new Date(r.latest_any_hb).getTime();
      if (age <= DAY) { reporting_today += 1; continue; }
      if (age > 2 * DAY) { stale += 1; stale_users.push({ id: r.id, name: r.name, email: r.email }); continue; }
    }
    // 24h–48h 灰區：算入 reporting（寬鬆）或 stale（嚴謹）— 選寬鬆，只警告 48h+
  }

  // Per-tool 覆蓋
  const perToolRes = await query(
    `SELECT tool,
            COUNT(*) FILTER (WHERE last_reported_at > NOW() - INTERVAL '24 hours') AS reporting,
            COUNT(*) FILTER (WHERE last_reported_at < NOW() - INTERVAL '48 hours') AS stale
       FROM collector_heartbeat
       GROUP BY tool`
  );
  const per_tool = {};
  for (const r of perToolRes.rows) {
    per_tool[r.tool] = { reporting: Number(r.reporting), stale: Number(r.stale) };
  }

  return {
    total_users: res.rows.length,
    reporting_today, stale, opted_out,
    stale_users, exempt_users,
    per_tool
  };
}

async function loadUsersAggregate({ query }, from, to) {
  // Tier 1 per-user aggregate（含 null-cost policy）
  // bool_or 要排除 LEFT JOIN 補出的純 NULL 列（d.id IS NULL = 無 matching row），
  // 否則完全沒 activity 的 user 會被誤判為「有 unknown pricing」→ cost_usd=null
  const tier1 = await query(
    `SELECT u.id, u.name, u.email,
            CASE WHEN bool_or(d.id IS NOT NULL AND d.cost_usd IS NULL) THEN NULL
                 ELSE COALESCE(SUM(d.cost_usd), 0)::float END AS cost_usd,
            COALESCE(SUM(d.input_tokens), 0)::bigint      AS input_tokens,
            COALESCE(SUM(d.output_tokens), 0)::bigint     AS output_tokens,
            COALESCE(SUM(d.cache_creation_tokens), 0)::bigint AS cache_creation_tokens,
            COALESCE(SUM(d.cache_read_tokens), 0)::bigint AS cache_read_tokens,
            COALESCE(SUM(d.reasoning_tokens), 0)::bigint  AS reasoning_tokens,
            COALESCE(SUM(d.message_count), 0)::int        AS message_count,
            COALESCE(SUM(d.wall_seconds), 0)::int         AS wall_seconds,
            COALESCE(SUM(d.active_seconds), 0)::int       AS active_seconds,
            COUNT(DISTINCT d.session_id)::int             AS session_count
       FROM users u
       LEFT JOIN token_usage_daily d
         ON d.user_id = u.id AND d.date >= $1 AND d.date <= $2
      GROUP BY u.id, u.name, u.email`,
    [from, to]
  );
  // Tier 2 per-user aggregate（Cursor / Antigravity）
  const tier2 = await query(
    `SELECT user_id,
            COALESCE(SUM(count), 0)::int AS tier2_sessions,
            COALESCE(SUM(wall_seconds), 0)::int AS tier2_wall_seconds
       FROM session_count
      WHERE date >= $1 AND date <= $2
      GROUP BY user_id`,
    [from, to]
  );
  const t2Map = new Map(tier2.rows.map((r) => [r.user_id, r]));

  const merged = tier1.rows.map((r) => {
    const t2 = t2Map.get(r.id);
    const t2Sessions = t2 ? Number(t2.tier2_sessions) : 0;
    const t2Wall = t2 ? Number(t2.tier2_wall_seconds) : 0;
    return {
      user: { id: r.id, name: r.name, email: r.email },
      totals: {
        cost_usd: r.cost_usd,   // 可能為 null（policy）
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_creation_tokens: r.cache_creation_tokens,
        cache_read_tokens: r.cache_read_tokens,
        reasoning_tokens: r.reasoning_tokens,
        message_count: r.message_count,
        wall_seconds: Number(r.wall_seconds) + t2Wall,
        active_seconds: r.active_seconds,
        session_count: Number(r.session_count) + t2Sessions
      }
    };
  });

  // 排序：cost_usd DESC，null 視為 -Infinity 排到最後
  merged.sort((a, b) => {
    const ac = a.totals.cost_usd ?? -Infinity;
    const bc = b.totals.cost_usd ?? -Infinity;
    if (bc !== ac) return bc - ac;
    return a.user.id - b.user.id;
  });
  return merged;
}

export default createTeamStatsRouter();
