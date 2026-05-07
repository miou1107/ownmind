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
      res.status(500).json({ error: '敘事報告產生失敗' });
    }
  });

  router.get('/insights', async (req, res) => {
    const apiKey = env.LLM_SWITCH_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error: '管理者尚未設定 LLM；機械版報告仍可用',
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
      res.status(502).json({ error: '洞察暫時無法產生，稍後再試' });
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

  // 1. ranking — 每 user 過去 N 天 sessions/events
  const ranking = (await query(`
    SELECT u.id, u.name, u.role,
      COUNT(*) FILTER (WHERE a.event='init') AS sessions,
      COUNT(a.id) AS events,
      MAX(a.ts) AS last_activity
    FROM users u
    LEFT JOIN activity_logs a ON a.user_id = u.id AND a.ts ${tfTs}
    GROUP BY u.id, u.name, u.role
    ORDER BY events DESC NULLS LAST
  `)).rows;

  // 2. versions — collector_heartbeat 各人每工具版本
  const versions = (await query(`
    SELECT user_id, tool, scanner_version AS version, last_reported_at
    FROM collector_heartbeat
    ORDER BY user_id, tool
  `)).rows;

  // 3. daily — 每天 activity 數
  const daily = (await query(`
    SELECT to_char(ts AT TIME ZONE 'Asia/Taipei', 'MM-DD') AS d, COUNT(*) AS c
    FROM activity_logs WHERE ts ${tfTs}
    GROUP BY d ORDER BY d
  `)).rows;

  // 4. hourly — 24 小時分布
  const hourly = (await query(`
    SELECT EXTRACT(HOUR FROM ts AT TIME ZONE 'Asia/Taipei')::int AS hour, COUNT(*) AS c
    FROM activity_logs WHERE ts ${tfTs}
    GROUP BY hour ORDER BY hour
  `)).rows;

  // 5. weekday — 週幾分布
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

  // 7. compliance — iron_rule 統計（同 me.js 的誠信邏輯）
  const compliance = (await query(`
    SELECT details->>'rule_code' AS rule_code,
      COUNT(*) FILTER (WHERE details->>'action'='comply' AND COALESCE(details->>'source','') NOT LIKE 'system_%') AS comply,
      COUNT(*) FILTER (WHERE details->>'action'='skip' AND COALESCE(details->>'source','') NOT LIKE 'system_%') AS skip,
      COUNT(*) FILTER (WHERE details->>'action'='violate') AS violate,
      COUNT(*) FILTER (WHERE details->>'action'='observed_trigger'
        OR (COALESCE(details->>'source','') LIKE 'system_%' AND details->>'action'='comply')) AS observed
    FROM activity_logs
    WHERE event='iron_rule_compliance' AND ts ${tfTs}
    GROUP BY rule_code ORDER BY rule_code
  `)).rows;

  // 8. update_health — 升級/檢查事件
  const update_health = (await query(`
    SELECT event, COUNT(*) AS c
    FROM activity_logs
    WHERE event IN ('update_check','update_success','update_failure','no_new_version','update_skipped','init_failed')
      AND ts ${tfTs}
    GROUP BY event
  `)).rows;

  // 9. project_ranking — 跨專案排行（同 me.js 的 LOWER/TRIM 正規化）
  const project_ranking = (await query(`
    SELECT LOWER(TRIM(details->>'project')) AS project_key,
      MIN(details->>'project') AS project,
      sl.user_id,
      u.name,
      COUNT(*) AS sessions,
      SUM(COALESCE((details->>'duration_turns')::int, 0)) AS turns
    FROM session_logs sl
    LEFT JOIN users u ON u.id = sl.user_id
    WHERE sl.created_at ${tfCreated}
      AND details->>'project' IS NOT NULL
      AND TRIM(details->>'project') != ''
    GROUP BY project_key, sl.user_id, u.name
    ORDER BY turns DESC NULLS LAST
  `)).rows;

  // 10. project_friction_raw — friction notes for LLM extraction
  const project_friction_raw = (await query(`
    SELECT LOWER(TRIM(details->>'project')) AS project_key,
      details->>'friction' AS friction
    FROM session_logs
    WHERE created_at ${tfCreated}
      AND details ? 'friction'
      AND details->>'friction' IS NOT NULL
      AND TRIM(details->>'friction') != ''
    LIMIT 100
  `)).rows;

  // 11. project_compliance — 各專案守了哪些鐵律
  const project_compliance = (await query(`
    SELECT details->>'project_key' AS project_key,
      details->>'rule_code' AS rule_code,
      COUNT(*) AS c
    FROM activity_logs
    WHERE event='iron_rule_compliance'
      AND details->>'action'='comply'
      AND COALESCE(details->>'source','') NOT LIKE 'system_%'
      AND ts ${tfTs}
      AND details ? 'project_key'
    GROUP BY project_key, rule_code
    ORDER BY project_key, rule_code
  `)).rows;

  return {
    ranking, versions, daily, hourly, weekday,
    event_types, compliance, update_health,
    project_ranking, project_friction_raw, project_compliance,
  };
}
