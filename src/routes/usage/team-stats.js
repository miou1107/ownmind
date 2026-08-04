import { Router } from 'express';
import { query as defaultQuery } from '../../utils/db.js';
import defaultAdminAuth from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';

/**
 * GET /api/usage/team-stats (admin+)
 *
 * Response:
 *   {
 *     period: { from, to },
 *     coverage: {
 *       total_users, measured, unmeasured, opted_out,
 *       unmeasured_users: [{ id, name, email }], exempt_users: [...]
 *     },
 *     users: [{ user: { id, name, email }, totals: {...} }, ...]
 *   }
 *
 * Coverage is always surfaced so a page ranking members can state the
 * denominator it is ranking over, rather than presenting a partial list as if
 * it were the whole team.
 */
export function createTeamStatsRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const adminAuth = deps.adminAuth ?? defaultAdminAuth;

  const router = Router();

  router.get('/', adminAuth, async (req, res) => {
    try {
      const { from, to } = parseParams(req.query);

      // Per-user aggregate (tokens / hours per user), then coverage derived from
      // it. Order matters: coverage is a summary of these same rows, not a
      // second measurement of the same thing.
      const users = await loadUsersAggregate({ query }, from, to);
      const exemptIds = await loadExemptUserIds({ query });

      res.json({
        period: { from, to },
        coverage: buildCoverage(users, exemptIds),
        users
      });
    } catch (err) {
      logger.error('team-stats query failed', { error: err.message });
      res.status(500).json({ error: 'Failed to query team usage' });
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

/** The ids of every member whose tracking exemption is still in force. */
async function loadExemptUserIds({ query }) {
  const res = await query(
    `SELECT user_id FROM usage_tracking_exemption
      WHERE expires_at IS NULL OR expires_at > NOW()`
  );
  return new Set(res.rows.map((r) => r.user_id));
}

/**
 * How much of the team the `users` array actually measures.
 *
 * v1.26.58: this used to be counted from `collector_heartbeat` — "has a collector
 * checked in recently" — which answers a different question than the one the page
 * asks. A collector can connect, heartbeat happily, and ship no usage at all.
 * Measured on production 2026-07-30 the old metric reported 8 of 9 members
 * covered while three of them had no usage data whatsoever. Counting the same
 * rows the table is built from means the panel and the ranking cannot disagree;
 * whether a collector is connected is a separate question, answered on 系統設定
 * by /api/usage/admin/clients.
 *
 * The three buckets partition the team, so the denominator is honest:
 *   measured   — reported something in the window, even if the numbers are zero
 *   opted_out  — nothing in the window, and an exemption explains why
 *   unmeasured — nothing in the window, and nothing explains it
 *
 * An exempt member with data in the window counts as measured: an exemption stops
 * future ingestion, it does not delete what was already collected, and calling
 * data we hold "no data" would understate real coverage.
 *
 * @param {Array<{user: {id: number, name: string, email: string}, totals: {has_usage_data: boolean}}>} users
 * @param {Set<number>} exemptIds
 */
export function buildCoverage(users, exemptIds) {
  let measured = 0;
  const unmeasured_users = [];
  const exempt_users = [];

  for (const row of users) {
    const { id, name, email } = row.user;
    if (row.totals?.has_usage_data) { measured += 1; continue; }
    if (exemptIds.has(id)) { exempt_users.push({ id, name, email }); continue; }
    unmeasured_users.push({ id, name, email });
  }

  return {
    total_users: users.length,
    measured,
    unmeasured: unmeasured_users.length,
    opted_out: exempt_users.length,
    unmeasured_users,
    exempt_users
  };
}

async function loadUsersAggregate({ query }, from, to) {
  // Tier 1 per-user aggregate (with null-cost policy).
  // bool_or must exclude rows that are purely NULL from the LEFT JOIN
  // (d.id IS NULL = no matching row); otherwise a user with no activity at
  // all would be wrongly flagged as having unknown pricing → cost_usd=null.
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
            COUNT(DISTINCT d.session_id)::int             AS session_count,
            -- v1.26.56: every column above is COALESCE'd to 0, so a member with
            -- no token_usage_daily row is indistinguishable from one who reported
            -- zeros. The console rendered both as "0 tokens", which is the exact
            -- confusion umbrella Requirement 7 forbids. This says which it is.
            bool_or(d.id IS NOT NULL)                     AS has_tier1_data
       FROM users u
       LEFT JOIN token_usage_daily d
         ON d.user_id = u.id AND d.date >= $1 AND d.date <= $2
      GROUP BY u.id, u.name, u.email`,
    [from, to]
  );
  // Tier 2 per-user aggregate (Cursor / Antigravity).
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
        cost_usd: r.cost_usd,   // may be null (policy)
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_creation_tokens: r.cache_creation_tokens,
        cache_read_tokens: r.cache_read_tokens,
        reasoning_tokens: r.reasoning_tokens,
        message_count: r.message_count,
        wall_seconds: Number(r.wall_seconds) + t2Wall,
        active_seconds: r.active_seconds,
        session_count: Number(r.session_count) + t2Sessions,
        // True when this member reported anything at all in the window, from
        // either tier. A Cursor-only user has no tier-1 row, so checking tier 1
        // alone would call them unmeasured while their sessions are on screen.
        has_usage_data: r.has_tier1_data === true || t2 !== undefined
      }
    };
  });

  // v1.26.58: ordered by tokens rather than by cost. Sorting by `cost_usd` had
  // quietly become sorting by user id, because it is null for everyone with data
  // (see Requirement 8), and every caller that wanted a ranking got insertion
  // order dressed up as one. The console re-sorts client-side, but the other two
  // pages calling this endpoint join by id and take what they are given.
  merged.sort((a, b) => {
    const usage = (t) => Number(t.input_tokens || 0) + Number(t.output_tokens || 0)
      + Number(t.reasoning_tokens || 0);
    const diff = usage(b.totals) - usage(a.totals);
    if (diff !== 0) return diff;
    return a.user.id - b.user.id;
  });
  return merged;
}

export default createTeamStatsRouter();
