/**
 * GET /api/me/overview?range=7|14|30  (any signed-in member)
 *
 * v1.32.2 — the data behind 總覽 (openspec v1.32.0-console-rebuild, Phase 2).
 *
 * One request, composed only from queries the console already runs elsewhere: the
 * per-user report (/api/me/report), the self-check (/api/usage/self-check), the inbox
 * lists (/api/handoff/pending, /api/session/lessons, /api/tasks?mine=true, the bug list)
 * and the admin client list's host check. Nothing here is a new measurement; the page's
 * rule is "no number the server does not have", and this file is where that is kept.
 *
 * Response:
 * {
 *   generated_at, range_days,
 *   lights: {
 *     memory:    { state, last_init_at, inits_24h, inits_7d },
 *     reporting: { state, machines: [{ machine, api_host, on_old_host, last_reported_at }],
 *                  stale_tools: [tool] },
 *     rules:     { state, checks, unverified }
 *   },
 *   pending: { handoffs: [...], lessons: [...], tasks: [...], bugs: [...] | null },
 *   tiles: {
 *     sessions:    { current, previous },
 *     compliance:  { rate | null, previous_rate | null, worst_rule | null },
 *     top_project: { project, sessions, handoffs } | null,
 *     last_activity: { ts, tool, project } | null,
 *     team_visible: { visible, total, invisible_names } | null   (admin+ only)
 *   },
 *   daily: [{ date, count }]   one row per day of the range, oldest first, zero-filled
 * }
 *
 * `state` is one of good | warn | bad | none. `none` means "the server has nothing to
 * say", which the page shows as such rather than as green.
 */

import { Router } from 'express';
import { query as defaultQuery } from '../utils/db.js';
import defaultAuth from '../middleware/auth.js';
import logger from '../utils/logger.js';
import { isAtLeast } from '../utils/roles.js';
import { canonicalHostOf } from './usage/admin-clients.js';

export const RANGES = [7, 14, 30];
const DEFAULT_RANGE = 7;

/** From v1.17.37 onward a session log auto-attaches a compliance array (see me.js). */
const COMPLIANCE_ARRAY_SINCE = '2026-05-07';

export function parseRange(raw) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return RANGES.includes(n) ? n : DEFAULT_RANGE;
}

export function createOverviewRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const auth = deps.auth ?? defaultAuth;
  const canonicalUrl = deps.canonicalUrl ?? (() => process.env.CANONICAL_URL || '');
  const now = deps.now ?? (() => new Date());

  const router = Router();
  router.use(auth);

  // v1.32.3 — the number on the 待你處理 entry and its tabs. Cheap on purpose: four
  // counts, read on every page change and after every inbox action.
  router.get('/pending-count', async (req, res) => {
    try {
      res.json(await buildPendingCount({ query, user: req.user }));
    } catch (err) {
      logger.error('me/overview/pending-count failed', { error: err.message });
      res.status(500).json({ error: 'Failed to count pending items' });
    }
  });

  router.get('/', async (req, res) => {
    try {
      const data = await buildOverview({
        query,
        user: req.user,
        rangeDays: parseRange(req.query.range),
        canonicalHost: canonicalHostOf(typeof canonicalUrl === 'function' ? canonicalUrl() : canonicalUrl),
        now: now(),
      });
      res.json(data);
    } catch (err) {
      logger.error('me/overview failed', { error: err.message });
      res.status(500).json({ error: 'Failed to build overview' });
    }
  });

  return router;
}

const int = (v) => Number.parseInt(v, 10) || 0;

/**
 * Everything the page needs, from the database. Exported so the composition is testable
 * with a fake `query`.
 */
export async function buildOverview({ query, user, rangeDays, canonicalHost, now }) {
  const uid = user.id;
  const admin = isAtLeast(user.role, 'admin');
  const days = `${rangeDays} days`;
  const twice = `${rangeDays * 2} days`;

  const [
    inits, heartbeats, staleTools, compliance, orphans,
    sessions, topProject, lastActivity, daily,
    handoffs, lessons, tasks, bugs, teamVisible,
  ] = await Promise.all([
    // 記憶主機: did the AI load memory recently? (same source as the self-check)
    query(
      `SELECT MAX(ts) AS last_init_at,
              COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL '24 hours')::int AS inits_24h,
              COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL '7 days')::int AS inits_7d
         FROM activity_logs
        WHERE user_id = $1 AND event = 'init'`,
      [uid],
    ),
    // 用量回報: my computers, with the host each one posts to (Phase 0's column).
    query(
      `SELECT machine, MAX(api_host) AS api_host, MAX(last_reported_at) AS last_reported_at
         FROM collector_heartbeat
        WHERE user_id = $1
        GROUP BY machine
        ORDER BY machine`,
      [uid],
    ),
    // Tools I used this week whose collector has not reported in a day (me.js #3).
    query(
      `WITH active AS (
         SELECT DISTINCT LOWER(TRIM(tool)) AS tool_key, MIN(tool) AS tool
           FROM activity_logs
          WHERE user_id = $1 AND ts >= NOW() - INTERVAL '7 days'
            AND tool IS NOT NULL AND tool NOT IN ('unknown', 'mcp')
          GROUP BY tool_key
       ), hb AS (
         SELECT LOWER(TRIM(tool)) AS tool_key, MAX(last_reported_at) AS last_hb
           FROM collector_heartbeat WHERE user_id = $1
          GROUP BY tool_key
       )
       SELECT a.tool FROM active a LEFT JOIN hb ON a.tool_key = hb.tool_key
        WHERE hb.last_hb IS NULL OR hb.last_hb < NOW() - INTERVAL '24 hours'
        ORDER BY a.tool`,
      [uid],
    ),
    // 規矩: this range and the one before, per rule (me.js myComplianceQ, two windows).
    query(
      `SELECT details->>'rule_code' AS rule_code,
              (ts >= NOW() - INTERVAL '${days}') AS current,
              COUNT(*) FILTER (WHERE details->>'action' = 'comply'
                                 AND COALESCE(details->>'source', '') NOT LIKE 'system_%')::int AS comply,
              COUNT(*) FILTER (WHERE details->>'action' = 'skip'
                                 AND COALESCE(details->>'source', '') NOT LIKE 'system_%')::int AS skip,
              COUNT(*) FILTER (WHERE details->>'action' = 'violate')::int AS violate,
              COUNT(*) FILTER (WHERE details->>'action' = 'observed_trigger'
                                 OR (COALESCE(details->>'source', '') LIKE 'system_%'
                                     AND details->>'action' = 'comply'))::int AS observed
         FROM activity_logs
        WHERE user_id = $1 AND event = 'iron_rule_compliance'
          AND ts >= NOW() - INTERVAL '${twice}'
        GROUP BY rule_code, current`,
      [uid],
    ),
    // Sessions long enough to have triggered something, with no compliance report (me.js #2).
    query(
      `SELECT COUNT(*)::int AS orphan_count
         FROM session_logs
        WHERE user_id = $1
          AND created_at >= NOW() - INTERVAL '${days}'
          AND created_at >= $2::timestamptz
          AND (details->'compliance' IS NULL OR jsonb_array_length(details->'compliance') = 0)
          AND COALESCE((details->>'duration_turns')::int, 0) >= 5`,
      [uid, COMPLIANCE_ARRAY_SINCE],
    ),
    // 你的 AI 對話: this range vs the one before.
    query(
      `SELECT COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL '${days}')::int AS current,
              COUNT(*) FILTER (WHERE ts <  NOW() - INTERVAL '${days}')::int AS previous
         FROM activity_logs
        WHERE user_id = $1 AND event = 'init' AND ts >= NOW() - INTERVAL '${twice}'`,
      [uid],
    ),
    // 你最常做的專案 (me.js myProjectsQ, first row) with its pending handoffs.
    query(
      `WITH p AS (
         SELECT LOWER(TRIM(REGEXP_REPLACE(details->>'project', '\\s*[\\(（].*$', ''))) AS project_key,
                MIN(REGEXP_REPLACE(details->>'project', '\\s*[\\(（].*$', '')) AS project,
                COUNT(*)::int AS sessions,
                SUM(COALESCE((details->>'duration_turns')::int, 0))::int AS turns
           FROM session_logs
          WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '${days}'
            AND details->>'project' IS NOT NULL AND TRIM(details->>'project') != ''
          GROUP BY project_key
          ORDER BY turns DESC NULLS LAST, sessions DESC
          LIMIT 1
       )
       SELECT p.project, p.sessions, p.turns,
              (SELECT COUNT(*)::int FROM handoffs h
                WHERE h.user_id = $1 AND h.status = 'pending'
                  AND LOWER(TRIM(h.project)) = p.project_key) AS handoffs
         FROM p`,
      [uid],
    ),
    // 最後一次活動.
    query(
      `SELECT ts, tool, details->>'project' AS project
         FROM activity_logs
        WHERE user_id = $1
        ORDER BY ts DESC
        LIMIT 1`,
      [uid],
    ),
    // 每天開幾場對話, zero-filled by the server so the chart never guesses at gaps.
    query(
      `WITH d AS (
         SELECT generate_series(
                  (NOW() AT TIME ZONE 'Asia/Taipei')::date - ($2::int - 1),
                  (NOW() AT TIME ZONE 'Asia/Taipei')::date, '1 day')::date AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
              COUNT(a.id)::int AS count
         FROM d
         LEFT JOIN activity_logs a
           ON a.user_id = $1 AND a.event = 'init'
          AND (a.ts AT TIME ZONE 'Asia/Taipei')::date = d.day
        GROUP BY d.day
        ORDER BY d.day`,
      [uid, rangeDays],
    ),
    // 等你處理 — the same rows the inbox tabs list, trimmed to what a sentence needs.
    query(
      `SELECT id, project, from_tool, from_machine, created_at
         FROM handoffs WHERE user_id = $1 AND status = 'pending'
        ORDER BY created_at DESC LIMIT 20`,
      [uid],
    ),
    query(
      `SELECT id, project FROM session_lessons
        WHERE user_id = $1 AND status = 'new'
        ORDER BY created_at DESC LIMIT 50`,
      [uid],
    ),
    query(
      `SELECT id, title, project FROM tasks
        WHERE user_id = $1 AND status = 'done'
        ORDER BY created_at DESC LIMIT 20`,
      [uid],
    ),
    admin
      ? query(
        `SELECT b.id, b.title, u.name AS reporter_name
           FROM bug_reports b LEFT JOIN users u ON u.id = b.user_id
          WHERE b.status = 'new'
          ORDER BY b.created_at DESC LIMIT 20`,
      )
      : Promise.resolve(null),
    // 看得到幾位同事 (admin): who has any activity in 14 days (me.js team_blindspot).
    admin
      ? query(
        `SELECT u.name,
                EXISTS (SELECT 1 FROM activity_logs a
                         WHERE a.user_id = u.id AND a.ts >= NOW() - INTERVAL '14 days') AS visible
           FROM users u
          ORDER BY u.id`,
      )
      : Promise.resolve(null),
  ]);

  // ── lights ──
  const ini = inits.rows[0] ?? {};
  const inits24 = int(ini.inits_24h);
  const inits7 = int(ini.inits_7d);
  const memory = {
    state: inits24 > 0 ? 'good' : inits7 > 0 ? 'warn' : 'none',
    last_init_at: toIso(ini.last_init_at),
    inits_24h: inits24,
    inits_7d: inits7,
  };

  const machines = (heartbeats.rows ?? []).map((r) => ({
    machine: r.machine,
    api_host: r.api_host ?? null,
    on_old_host: Boolean(canonicalHost && r.api_host && r.api_host !== canonicalHost),
    last_reported_at: toIso(r.last_reported_at),
  }));
  const stale = (staleTools.rows ?? []).map((r) => r.tool);
  const reporting = {
    state: machines.length === 0 ? 'none'
      : machines.some((m) => m.on_old_host) ? 'bad'
        : stale.length > 0 ? 'warn'
          : 'good',
    machines,
    stale_tools: stale,
  };

  const cur = (compliance.rows ?? []).filter((r) => r.current === true || r.current === 't');
  const prev = (compliance.rows ?? []).filter((r) => !(r.current === true || r.current === 't'));
  const checks = cur.reduce((n, r) => n + int(r.comply) + int(r.skip) + int(r.violate) + int(r.observed), 0);
  const unverified = int(orphans.rows[0]?.orphan_count);
  const rules = {
    state: checks === 0 ? 'none' : unverified > 0 ? 'warn' : 'good',
    checks,
    unverified,
  };

  // ── tiles ──
  const s = sessions.rows[0] ?? {};
  const rate = complianceRate(cur);
  const previousRate = complianceRate(prev);
  const worst = cur
    .filter((r) => int(r.violate) > 0)
    .sort((a, b) => int(b.violate) - int(a.violate))[0];
  const tp = topProject.rows[0];
  const la = lastActivity.rows[0];
  const tv = teamVisible?.rows ?? null;

  const tiles = {
    sessions: { current: int(s.current), previous: int(s.previous) },
    compliance: {
      rate,
      previous_rate: previousRate,
      worst_rule: worst ? { code: worst.rule_code, violate: int(worst.violate) } : null,
    },
    top_project: tp ? { project: tp.project, sessions: int(tp.sessions), turns: int(tp.turns), handoffs: int(tp.handoffs) } : null,
    last_activity: la ? { ts: toIso(la.ts), tool: la.tool ?? null, project: la.project ?? null } : null,
    team_visible: tv
      ? {
        visible: tv.filter((r) => r.visible === true || r.visible === 't').length,
        total: tv.length,
        invisible_names: tv.filter((r) => !(r.visible === true || r.visible === 't')).map((r) => r.name),
      }
      : null,
  };

  // The worst rule's title, when the page wants to name it: resolved from memories by
  // code, in one more small query, only when there is one to name.
  if (tiles.compliance.worst_rule) {
    const titleQ = await query(
      `SELECT title FROM memories WHERE type = 'iron_rule' AND code = $1 LIMIT 1`,
      [tiles.compliance.worst_rule.code],
    );
    tiles.compliance.worst_rule.title = titleQ.rows[0]?.title ?? null;
  }

  return {
    generated_at: (now ?? new Date()).toISOString(),
    range_days: rangeDays,
    lights: { memory, reporting, rules },
    pending: {
      handoffs: (handoffs.rows ?? []).map((h) => ({
        id: h.id, project: h.project, from_tool: h.from_tool ?? null,
        from_machine: h.from_machine ?? null, created_at: toIso(h.created_at),
      })),
      lessons: (lessons.rows ?? []).map((l) => ({ id: l.id, project: l.project ?? null })),
      tasks: (tasks.rows ?? []).map((x) => ({ id: x.id, title: x.title, project: x.project })),
      bugs: bugs ? (bugs.rows ?? []).map((b) => ({ id: b.id, title: b.title, reporter_name: b.reporter_name ?? null })) : null,
    },
    tiles,
    daily: (daily.rows ?? []).map((r) => ({ date: r.date, count: int(r.count) })),
  };
}

/**
 * How many items wait in each inbox tab, for the caller.
 *
 * `bugs` is null for a member: the bug list is not theirs to handle, so it is neither
 * counted nor queried. `total` is what the rail shows.
 */
export async function buildPendingCount({ query, user }) {
  const uid = user.id;
  const admin = isAtLeast(user.role, 'admin');
  const [h, l, t, b] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n FROM handoffs WHERE user_id = $1 AND status = 'pending'`, [uid]),
    query(`SELECT COUNT(*)::int AS n FROM session_lessons WHERE user_id = $1 AND status = 'new'`, [uid]),
    query(`SELECT COUNT(*)::int AS n FROM tasks WHERE user_id = $1 AND status = 'done'`, [uid]),
    admin
      ? query(`SELECT COUNT(*)::int AS n FROM bug_reports WHERE status = 'new'`)
      : Promise.resolve(null),
  ]);
  const counts = {
    handoffs: int(h.rows[0]?.n),
    lessons: int(l.rows[0]?.n),
    tasks: int(t.rows[0]?.n),
    bugs: b ? int(b.rows[0]?.n) : null,
  };
  counts.total = counts.handoffs + counts.lessons + counts.tasks + (counts.bugs ?? 0);
  return counts;
}

/** comply ÷ (comply + skip + violate); null when nothing was reported. */
export function complianceRate(rows) {
  let c = 0; let s = 0; let v = 0;
  for (const r of rows ?? []) { c += int(r.comply); s += int(r.skip); v += int(r.violate); }
  const total = c + s + v;
  return total === 0 ? null : c / total;
}

function toIso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default createOverviewRouter();
