/**
 * GET /api/me/overview?range=7|14|30  (any signed-in member)
 *
 * v1.32.2 — the data behind 總覽 (openspec v1.32.0-console-rebuild, Phase 2).
 * Home redesign — the page answers two questions the owner opens it for: is the AI keeping
 * the rules, and how is the team using it. The four stat tiles and the daily chart are gone
 * (用量與規矩 still has usage); the inbox preview became a short list of recent decisions.
 *
 * Composed only from tables the console already reads: activity_logs (init and
 * iron_rule_compliance events, as /api/me/report and the old tiles counted them),
 * session_logs (the unreported-session check), memories (rule titles), the inbox tables,
 * and collector_heartbeat. No LLM call, no new measurement.
 *
 * Response:
 * {
 *   generated_at, range_days,
 *   lights: {
 *     memory:    { state, last_init_at, inits_24h, inits_7d },
 *     reporting: { state, machines: [{ machine, api_host, on_old_host, last_reported_at }],
 *                  stale_tools: [tool] }
 *   },
 *   rules: { rate | null, previous_rate | null, comply, missed, total, unreported,
 *            top_missed: [{ code, title | null, missed }] }       (at most 3, worst first)
 *   team: [{ user_id, name, is_me, sessions, rate | null, comply, missed,
 *            last_active_at | null, inactive_14d }] | null       (admin+ only)
 *   decisions: { recent_days, handoffs: [{ project, count, latest_at }],
 *                lessons: { count, latest_at | null },
 *                tasks: [{ id, title, project, done_at }], tasks_count,
 *                bugs: [{ id, title, reporter_name, updated_at }] | null, bugs_count | null,
 *                hidden }   (hidden = still waiting but untouched for more than recent_days)
 * }
 *
 * `state` is one of good | warn | bad | none. `none` means "the server has nothing to
 * say", which the page shows as such rather than as green.
 *
 * "missed" is skip + violate: the times the AI did not do what the rule says. The rate is
 * comply ÷ (comply + skip + violate), the formula 用量與規矩 › 規矩遵守 shows.
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
 * One conversation, once (v1.32.8). The hook puts Claude Code's session id on its init
 * event; a row without one is its own conversation, as every row was before.
 */
const SESSION_KEY_A = "COALESCE(a.details->>'session_id', a.id::text)";

/**
 * activity_logs.tool is the AI tool (claude-code, codex…) on hook and scanner rows, but
 * the MCP function name (ownmind_search…) on mcp_call rows, plus 'scanner' and 'server'
 * for the two services. Only the first kind has a collector that can be silent or a name
 * worth showing as "the tool you used".
 */
const IS_AI_TOOL = "(tool NOT LIKE 'ownmind\\_%' AND tool NOT IN ('scanner', 'server'))";

/** Decisions untouched for longer than this are left off the home page (still in the inbox). */
export const RECENT_DECISION_DAYS = 7;

/** How many rules the 「AI 守規矩」 card names. */
const TOP_RULES = 3;

/** A teammate with no activity at all for this long is "not using it". */
const INACTIVE_DAYS = 14;

const isTrue = (v) => v === true || v === 't';

/**
 * Everything the page needs, from the database. Exported so the composition is testable
 * with a fake `query`.
 */
export async function buildOverview({ query, user, rangeDays, canonicalHost, now }) {
  const uid = user.id;
  const admin = isAtLeast(user.role, 'admin');
  const days = `${rangeDays} days`;
  const twice = `${rangeDays * 2} days`;
  const recent = `${RECENT_DECISION_DAYS} days`;
  const recentBugsSql = admin
    ? `(SELECT COUNT(*) FROM bug_reports
         WHERE status = 'new' AND updated_at >= NOW() - INTERVAL '${recent}')::int`
    : 'NULL::int';

  const [
    inits, heartbeats, staleTools, compliance, orphans,
    team, handoffs, lessons, tasks, bugs, recentCounts, counts,
  ] = await Promise.all([
    // 記憶: did the AI load memory recently? (same source as the self-check)
    query(
      `SELECT MAX(ts) AS last_init_at,
              COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL '24 hours')::int AS inits_24h,
              COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL '7 days')::int AS inits_7d
         FROM activity_logs
        WHERE user_id = $1 AND event = 'init'`,
      [uid],
    ),
    // 每台電腦: my computers, with the host each one posts to (Phase 0's column).
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
            AND ${IS_AI_TOOL}
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
    // AI 守規矩: this range and the one before, per rule (me.js myComplianceQ, two windows).
    query(
      `SELECT details->>'rule_code' AS rule_code,
              (ts >= NOW() - INTERVAL '${days}') AS current,
              COUNT(*) FILTER (WHERE details->>'action' = 'comply'
                                 AND COALESCE(details->>'source', '') NOT LIKE 'system_%')::int AS comply,
              COUNT(*) FILTER (WHERE details->>'action' = 'skip'
                                 AND COALESCE(details->>'source', '') NOT LIKE 'system_%')::int AS skip,
              COUNT(*) FILTER (WHERE details->>'action' = 'violate')::int AS violate
         FROM activity_logs
        WHERE user_id = $1 AND event = 'iron_rule_compliance'
          AND ts >= NOW() - INTERVAL '${twice}'
        GROUP BY rule_code, current`,
      [uid],
    ),
    // Sessions long enough to have triggered something, with no compliance report (me.js #2):
    // the card's footnote, "AI 沒交成績".
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
    // 同事用得怎樣 (admin+, as /api/usage/team-overview is): per person, conversations in
    // the range (counted once per session id, v1.32.8), the same compliance formula as the
    // card above, and the last time anything of theirs arrived.
    admin
      ? query(
        `SELECT u.id AS user_id, u.name,
                (SELECT MAX(a.ts) FROM activity_logs a WHERE a.user_id = u.id) AS last_active_at,
                (SELECT COUNT(DISTINCT ${SESSION_KEY_A})
                   FROM activity_logs a
                  WHERE a.user_id = u.id AND a.event = 'init'
                    AND a.ts >= NOW() - INTERVAL '${days}')::int AS sessions,
                COALESCE(c.comply, 0)::int AS comply,
                COALESCE(c.skip, 0)::int AS skip,
                COALESCE(c.violate, 0)::int AS violate
           FROM users u
           LEFT JOIN (
             SELECT user_id,
                    COUNT(*) FILTER (WHERE details->>'action' = 'comply'
                                       AND COALESCE(details->>'source', '') NOT LIKE 'system_%') AS comply,
                    COUNT(*) FILTER (WHERE details->>'action' = 'skip'
                                       AND COALESCE(details->>'source', '') NOT LIKE 'system_%') AS skip,
                    COUNT(*) FILTER (WHERE details->>'action' = 'violate') AS violate
               FROM activity_logs
              WHERE event = 'iron_rule_compliance' AND ts >= NOW() - INTERVAL '${days}'
              GROUP BY user_id
           ) c ON c.user_id = u.id
          ORDER BY u.id`,
      )
      : Promise.resolve(null),
    // 要你決定的事 — only what moved in the last week. Older items stay in the inbox; the
    // home page just stops listing them. Nothing is deleted or changed here.
    query(
      `SELECT MIN(project) AS project, COUNT(*)::int AS count, MAX(created_at) AS latest_at
         FROM handoffs
        WHERE user_id = $1 AND status = 'pending'
          AND created_at >= NOW() - INTERVAL '${recent}'
        GROUP BY LOWER(TRIM(COALESCE(project, '')))
        ORDER BY latest_at DESC`,
      [uid],
    ),
    query(
      `SELECT COUNT(*)::int AS count, MAX(created_at) AS latest_at
         FROM session_lessons
        WHERE user_id = $1 AND status = 'new'
          AND created_at >= NOW() - INTERVAL '${recent}'`,
      [uid],
    ),
    query(
      `SELECT id, title, project, COALESCE(done_at, updated_at, created_at) AS done_at
         FROM tasks
        WHERE user_id = $1 AND status = 'done'
          AND COALESCE(done_at, updated_at, created_at) >= NOW() - INTERVAL '${recent}'
        ORDER BY 4 DESC LIMIT 5`,
      [uid],
    ),
    admin
      ? query(
        `SELECT b.id, b.title, u.name AS reporter_name, b.updated_at
           FROM bug_reports b LEFT JOIN users u ON u.id = b.user_id
          WHERE b.status = 'new' AND b.updated_at >= NOW() - INTERVAL '${recent}'
          ORDER BY b.updated_at DESC LIMIT 5`,
      )
      : Promise.resolve(null),
    // How many recent tasks and bugs there are beyond the five listed.
    query(
      `SELECT (SELECT COUNT(*) FROM tasks
                WHERE user_id = $1 AND status = 'done'
                  AND COALESCE(done_at, updated_at, created_at) >= NOW() - INTERVAL '${recent}')::int AS recent_tasks,
              ${recentBugsSql} AS recent_bugs`,
      [uid],
    ),
    // Everything still waiting, recent or not: the difference is what the page leaves off.
    buildPendingCount({ query, user }),
  ]);

  // ── lights (the footer line) ──
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

  // ── AI 守規矩 ──
  const cur = (compliance.rows ?? []).filter((r) => isTrue(r.current));
  const prev = (compliance.rows ?? []).filter((r) => !isTrue(r.current));
  const comply = cur.reduce((n, r) => n + int(r.comply), 0);
  const missed = cur.reduce((n, r) => n + int(r.skip) + int(r.violate), 0);

  // A miss reported without a rule code still counts against the rate, but cannot be named.
  const byCode = new Map();
  for (const r of cur) {
    if (!r.rule_code) continue;
    byCode.set(r.rule_code, (byCode.get(r.rule_code) ?? 0) + int(r.skip) + int(r.violate));
  }
  const topMissed = [...byCode.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, TOP_RULES)
    .map(([code, n]) => ({ code, title: null, missed: n }));

  if (topMissed.length) {
    // Codes are per owner (IR-XXX can be two people's different rules), so the caller's own
    // rule wins, then an active one, then the newest.
    const titles = await query(
      `SELECT DISTINCT ON (code) code, title
         FROM memories
        WHERE type IN ('iron_rule', 'team_standard') AND code = ANY($1::text[])
        ORDER BY code, (user_id = $2) DESC, (status = 'active') DESC, id DESC`,
      [topMissed.map((r) => r.code), uid],
    );
    const titleOf = new Map((titles.rows ?? []).map((r) => [r.code, r.title]));
    for (const r of topMissed) r.title = titleOf.get(r.code) ?? null;
  }

  const rules = {
    rate: complianceRate(cur),
    previous_rate: complianceRate(prev),
    comply,
    missed,
    total: comply + missed,
    unreported: int(orphans.rows[0]?.orphan_count),
    top_missed: topMissed,
  };

  // ── 同事用得怎樣 ──
  const nowMs = (now ?? new Date()).getTime();
  const teamRows = team
    ? (team.rows ?? []).map((r) => {
      const c = int(r.comply);
      const m = int(r.skip) + int(r.violate);
      const last = toIso(r.last_active_at);
      return {
        user_id: r.user_id,
        name: r.name ?? '',
        is_me: r.user_id === uid,
        sessions: int(r.sessions),
        rate: c + m === 0 ? null : c / (c + m),
        comply: c,
        missed: m,
        last_active_at: last,
        inactive_14d: !last || nowMs - new Date(last).getTime() > INACTIVE_DAYS * 86400000,
      };
    })
    : null;

  // ── 要你決定的事 ──
  const handoffGroups = (handoffs.rows ?? []).map((h) => ({
    project: h.project ?? null, count: int(h.count), latest_at: toIso(h.latest_at),
  }));
  const ls = lessons.rows[0] ?? {};
  const rc = recentCounts.rows[0] ?? {};
  const recentHandoffs = handoffGroups.reduce((n, h) => n + h.count, 0);
  const recentLessons = int(ls.count);
  const taskList = tasks.rows ?? [];
  const recentTasks = Math.max(int(rc.recent_tasks), taskList.length);
  const bugList = bugs ? (bugs.rows ?? []) : null;
  const recentBugs = bugList ? Math.max(int(rc.recent_bugs), bugList.length) : 0;
  const decisions = {
    recent_days: RECENT_DECISION_DAYS,
    handoffs: handoffGroups,
    lessons: { count: recentLessons, latest_at: toIso(ls.latest_at) },
    tasks: taskList.map((x) => ({ id: x.id, title: x.title, project: x.project ?? null, done_at: toIso(x.done_at) })),
    tasks_count: recentTasks,
    bugs: bugList
      ? bugList.map((b) => ({ id: b.id, title: b.title, reporter_name: b.reporter_name ?? null, updated_at: toIso(b.updated_at) }))
      : null,
    bugs_count: bugList ? recentBugs : null,
    hidden: Math.max(0, counts.total - (recentHandoffs + recentLessons + recentTasks + recentBugs)),
  };

  return {
    generated_at: (now ?? new Date()).toISOString(),
    range_days: rangeDays,
    lights: { memory, reporting },
    rules,
    team: teamRows,
    decisions,
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
