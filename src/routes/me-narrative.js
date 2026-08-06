import { Router } from 'express';
import { buildMessages, callLLMSwitch, computeDataHash } from '../lib/llm-narrative.js';
import { createNarrativeCache } from '../lib/narrative-cache.js';

export function createNarrativeRouter({
  query, auth,
  llmCall,
  cache,
  env = process.env,
}) {
  const router = Router();
  router.use(auth);

  const insightsCache = cache || createNarrativeCache({ ttlMs: 3_600_000 });
  const defaultLLM = async ({ apiKey, messages }) => callLLMSwitch({ apiKey, messages });
  const callLLM = llmCall || defaultLLM;

  router.get('/', async (req, res) => {
    try {
      const range = String(req.query.range || '14d');
      const sections = await collectSections({ query, range });
      res.json({
        range,
        generated_at: new Date().toISOString(),
        sections,
      });
    } catch (err) {
      console.error('[me-narrative] mechanical failed:', err);
      res.status(500).json({ error: 'Failed to generate narrative report' });
    }
  });

  router.get('/insights', async (req, res) => {
    const apiKey = env.LLM_SWITCH_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error: 'Admin has not configured an LLM; the mechanical report is still available',
        code: 'no_api_key',
      });
    }
    try {
      const range = String(req.query.range || '14d');
      const sections = await collectSections({ query, range });
      const redacted = redactPIIDeep(sections);
      const hash = computeDataHash(redacted);
      const cacheKey = `${range}:${hash}`;
      const hit = insightsCache.get(cacheKey);
      if (hit) return res.json({ cached: true, ...hit });

      const messages = buildMessages(redacted);
      const result = await callLLM({ apiKey, messages });
      insightsCache.set(cacheKey, result);
      res.json({ cached: false, ...result });
    } catch (err) {
      console.error('[me-narrative] insights failed:', err);
      res.status(502).json({ error: 'Insights temporarily unavailable; please try again later' });
    }
  });

  return router;
}

function redactPIIDeep(value) {
  const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
  if (typeof value === 'string') {
    return value.replace(EMAIL_RE, '[email]').replace(IP_RE, '[ip]');
  }
  if (Array.isArray(value)) return value.map(redactPIIDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactPIIDeep(value[k]);
    return out;
  }
  return value;
}

function buildTimeFilter(range) {
  const interval = ({
    '7d': '7 days',
    '14d': '14 days',
    '30d': '30 days',
    'all': '100 years',
  })[range] || '14 days';
  return `>= NOW() - INTERVAL '${interval}'`;
}

async function collectSections({ query, range }) {
  const tf = buildTimeFilter(range);
  const tfTs = tf;      // for activity_logs.ts
  const tfCreated = tf; // for session_logs.created_at

  // 1. ranking — per-user sessions/events over the last N days.
  //
  // v1.26.46: `measured` separates "we have never received anything from this member" from
  // "this member was idle in this period". The LEFT JOIN produces zeros for both, and this
  // payload is fed to an LLM which will happily turn an unmarked zero into the confident
  // sentence "X hardly uses OwnMind". A blank cell invites suspicion; a sentence settles
  // the question, so prose needs the distinction more than a table does.
  //
  // Review caught the first version defining it as "count in this period > 0", which is the
  // mirror image of the bug it was meant to fix: a member on a week's leave would be
  // reported as having no data at all. Both halves of Requirement 7 have to hold, and "a
  // real zero still reads as zero" is the half that breaks.
  //
  // So it asks whether the member is instrumented at all, not whether they were busy:
  //   - a collector_heartbeat row means OwnMind is installed and has reported. That table
  //     holds current state, so it survives the activity_logs retention window
  //   - any activity_logs row means the MCP server has seen them, which covers someone
  //     using OwnMind through tools without ever running the token collector
  // Instrumented and zero this period is a real zero. Neither is genuinely unmeasured.
  const ranking = (await query(`
    SELECT u.id, u.name, u.role,
      COUNT(*) FILTER (WHERE a.event='init') AS sessions,
      COUNT(a.id) AS events,
      MAX(a.ts) AS last_activity,
      (
        EXISTS (SELECT 1 FROM collector_heartbeat h WHERE h.user_id = u.id)
        OR EXISTS (SELECT 1 FROM activity_logs x WHERE x.user_id = u.id)
      ) AS measured
    FROM users u
    LEFT JOIN activity_logs a ON a.user_id = u.id AND a.ts ${tfTs}
    GROUP BY u.id, u.name, u.role
    ORDER BY events DESC NULLS LAST
  `)).rows;

  // 2. versions — collector_heartbeat per-user per-tool version.
  //
  // v1.26.73 — one row per (user, tool, machine) now, so DISTINCT ON collapses a person's
  // computers back to one answer per tool: the one their most recently active machine
  // reports. Without it every two-machine member appears twice in the version list.
  const versions = (await query(`
    SELECT DISTINCT ON (user_id, tool)
           user_id, tool, scanner_version AS version, last_reported_at, machine
    FROM collector_heartbeat
    ORDER BY user_id, tool, last_reported_at DESC
  `)).rows;

  // 3. daily — activity count per day.
  const daily = (await query(`
    SELECT to_char(ts AT TIME ZONE 'Asia/Taipei', 'MM-DD') AS d, COUNT(*) AS c
    FROM activity_logs WHERE ts ${tfTs}
    GROUP BY d ORDER BY d
  `)).rows;

  // 4. hourly — 24-hour distribution.
  const hourly = (await query(`
    SELECT EXTRACT(HOUR FROM ts AT TIME ZONE 'Asia/Taipei')::int AS hour, COUNT(*) AS c
    FROM activity_logs WHERE ts ${tfTs}
    GROUP BY hour ORDER BY hour
  `)).rows;

  // 5. weekday — day-of-week distribution.
  const weekday = (await query(`
    SELECT EXTRACT(DOW FROM ts AT TIME ZONE 'Asia/Taipei')::int AS dow, COUNT(*) AS c
    FROM activity_logs WHERE ts ${tfTs}
    GROUP BY dow ORDER BY dow
  `)).rows;

  // 6. event_types
  const event_types = (await query(`
    SELECT event, COUNT(*) AS c
    FROM activity_logs WHERE ts ${tfTs}
    GROUP BY event ORDER BY c DESC
  `)).rows;

  // 7. compliance — iron_rule statistics (same honesty logic as me.js).
  // v1.17.52: switched to per-user × rule_code so each rule pairs with the
  //          user's own title (each user's rules can differ, including
  //          customized variants; merging the display would mislead).
  // v1.17.53: drop rows where all four counts are zero; sort by violate DESC
  //          so problems show up first.
  const compliance = (await query(`
    WITH stats AS (
      SELECT user_id, details->>'rule_code' AS rule_code,
        COUNT(*) FILTER (WHERE details->>'action'='comply' AND COALESCE(details->>'source','') NOT LIKE 'system_%') AS comply,
        COUNT(*) FILTER (WHERE details->>'action'='skip' AND COALESCE(details->>'source','') NOT LIKE 'system_%') AS skip,
        COUNT(*) FILTER (WHERE details->>'action'='violate') AS violate,
        COUNT(*) FILTER (WHERE details->>'action'='observed_trigger'
          OR (COALESCE(details->>'source','') LIKE 'system_%' AND details->>'action'='comply')) AS observed
      FROM activity_logs
      WHERE event='iron_rule_compliance' AND ts ${tfTs}
      GROUP BY user_id, rule_code
    )
    SELECT s.user_id, u.name AS user_name,
      s.rule_code, m.title,
      s.comply, s.skip, s.violate, s.observed
    FROM stats s
    LEFT JOIN users u ON u.id = s.user_id
    LEFT JOIN memories m
      ON m.user_id = s.user_id AND m.code = s.rule_code
      AND m.type = 'iron_rule' AND m.status = 'active'
    WHERE (s.comply + s.skip + s.violate + s.observed) > 0
    ORDER BY s.violate DESC, u.name NULLS LAST, s.rule_code
  `)).rows;

  // 8. update_health — upgrade / check events.
  const update_health = (await query(`
    SELECT event, COUNT(*) AS c
    FROM activity_logs
    WHERE event IN ('update_check','update_success','update_failure','no_new_version','update_skipped','init_failed')
      AND ts ${tfTs}
    GROUP BY event
  `)).rows;

  // 9. project_ranking — ranking across projects.
  // v1.17.55: added tokens (tried JOIN via session_id but session_logs.session_id is
  // all NULL — failed).
  // v1.26.60: the cost half went with Requirement 8. It mattered more here than in a
  // table: this payload is fed to an LLM, and a per-project dollar figure derived from
  // an unmaintained price list is exactly the kind of number prose turns into a
  // confident claim.
  // v1.17.56: use (user_id, tool) as a bridge — values are estimates
  // (allocated by turn ratio); project names are normalized with
  // REGEXP_REPLACE that strips the trailing "(...)" description, so
  // "ai_kol" and "ai_kol (xxx)" don't split into two rows.
  const project_ranking = (await query(`
    WITH usr_tok AS (
      SELECT user_id, tool,
        SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)
            + COALESCE(cache_creation_tokens,0) + COALESCE(cache_read_tokens,0)
            + COALESCE(reasoning_tokens,0)) AS tokens
      FROM token_usage_daily
      WHERE last_ts ${tfTs}
      GROUP BY user_id, tool
    ),
    proj AS (
      SELECT
        LOWER(TRIM(REGEXP_REPLACE(sl.details->>'project', '\\s*[\\(（].*$', ''))) AS project_key,
        MIN(REGEXP_REPLACE(sl.details->>'project', '\\s*[\\(（].*$', '')) AS project,
        sl.user_id, sl.tool, u.name,
        COUNT(*) AS sessions,
        SUM(COALESCE((sl.details->>'duration_turns')::int, 0)) AS turns
      FROM session_logs sl
      LEFT JOIN users u ON u.id = sl.user_id
      WHERE sl.created_at ${tfCreated}
        AND sl.details->>'project' IS NOT NULL
        AND TRIM(sl.details->>'project') != ''
      GROUP BY project_key, sl.user_id, sl.tool, u.name
    ),
    ut_turns AS (
      SELECT user_id, tool, SUM(turns) AS total_turns
      FROM proj
      GROUP BY user_id, tool
    )
    SELECT p.project_key,
      MIN(p.project) AS project,
      p.user_id, p.name,
      SUM(p.sessions)::int AS sessions,
      SUM(p.turns)::int AS turns,
      COALESCE(SUM(
        CASE WHEN utt.total_turns > 0 AND ut.tokens IS NOT NULL
          THEN ut.tokens::numeric * p.turns / utt.total_turns
          ELSE 0 END
      ), 0)::bigint AS tokens
    FROM proj p
    LEFT JOIN usr_tok ut ON ut.user_id = p.user_id AND ut.tool = p.tool
    LEFT JOIN ut_turns utt ON utt.user_id = p.user_id AND utt.tool = p.tool
    GROUP BY p.project_key, p.user_id, p.name
    ORDER BY turns DESC NULLS LAST
  `)).rows;

  // 10. project_friction_raw — friction notes for LLM extraction.
  // The real field name is friction_points (see src/utils/report.js and the
  // writer in src/routes/activity.js).
  const project_friction_raw = (await query(`
    SELECT LOWER(TRIM(details->>'project')) AS project_key,
      details->>'friction_points' AS friction
    FROM session_logs
    WHERE created_at ${tfCreated}
      AND details ? 'friction_points'
      AND details->>'friction_points' IS NOT NULL
      AND TRIM(details->>'friction_points') != ''
    LIMIT 100
  `)).rows;

  // 11. project_compliance — not implemented.
  // iron_rule_compliance details have no project_key written by any writer
  // (activity is recorded at trigger time and isn't necessarily inside a
  // session). Doing this properly would need JOIN session_logs with a
  // user/time window, with significant inaccuracy; YAGNI, skip for now.
  const project_compliance = [];

  return {
    ranking, versions, daily, hourly, weekday,
    event_types, compliance, update_health,
    project_ranking, project_friction_raw, project_compliance,
  };
}
