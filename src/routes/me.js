/**
 * /api/me — user-accessible usage report endpoint (v1.17.24).
 *
 * Open to any role (user / admin / super_admin); offers:
 *   - GET /profile — authenticate by api_key, returns minimal data.
 *   - GET /report — personal + team + project aggregated data.
 *
 * Design decisions:
 *   - Uses the regular auth middleware (does not block user role).
 *   - Q1=C fully open, no anonymization (members see each other's activity).
 *   - Q2=B all team projects are visible (no conversation content).
 */

import { Router } from 'express';
import bcrypt from 'bcrypt';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = Router();
const BCRYPT_ROUNDS = 10;

/**
 * POST /api/me/login — email + password login (from v1.17.25, accepts any role).
 * On success returns api_key + must_change_password flag.
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: '請輸入 Email 和密碼' });
    }
    const result = await query(
      `SELECT id, email, name, role, api_key, password_hash, must_change_password
       FROM users WHERE LOWER(email) = LOWER($1)`,
      [email]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }
    const user = result.rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ error: '此帳號尚未設定密碼，請聯絡管理員' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }
    res.json({
      id: user.id,
      api_key: user.api_key,
      name: user.name,
      email: user.email,
      role: user.role,
      must_change_password: !!user.must_change_password,
    });
  } catch (err) {
    logger.error('me/login failed', { error: err.message });
    res.status(500).json({ error: '登入失敗' });
  }
});

// All endpoints below require Bearer api_key auth (any role).
router.use(auth);

/**
 * POST /api/me/change-password — change one's own password.
 * Body: { current_password, new_password }
 * The must_change_password flag is cleared automatically.
 */
router.post('/change-password', async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
      return res.status(400).json({ error: '請輸入舊密碼和新密碼' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: '新密碼長度至少 8 字元' });
    }
    if (new_password === current_password) {
      return res.status(400).json({ error: '新密碼必須跟舊密碼不一樣' });
    }
    const cur = await query(
      `SELECT password_hash FROM users WHERE id = $1`, [req.user.id]
    );
    const ok = cur.rows[0]?.password_hash &&
      await bcrypt.compare(current_password, cur.rows[0].password_hash);
    if (!ok) {
      // Return 400, not 401: client.js treats 401 as "token expired" and
      // kicks the user back to /login. A wrong old password is a user-input
      // error, not an authentication failure — 400 matches the semantics.
      return res.status(400).json({ error: '舊密碼錯誤' });
    }
    const hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    await query(
      `UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2`,
      [hash, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error('me/change-password failed', { error: err.message });
    res.status(500).json({ error: '修改密碼失敗' });
  }
});

/**
 * GET /profile — verify api_key and return an identity summary.
 * The front-end uses this to confirm the key is valid and to show the
 * user's name.
 */
router.get('/profile', async (req, res) => {
  const u = req.user;
  // Also fetch must_change_password (the auth middleware's SELECT does not
  // include this column).
  const r = await query(
    `SELECT must_change_password FROM users WHERE id = $1`, [u.id]
  );
  res.json({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    created_at: u.created_at,
    must_change_password: !!r.rows[0]?.must_change_password,
  });
});

/**
 * PUT /profile — change one's own name (added in v1.20.1 alongside the
 * Dashboard personal-profile page).
 *
 * Only name may be changed. The user cannot change their own email / role:
 *   - email: unique index; changes must go through admin (so the login
 *     account cannot be hijacked).
 *   - role: requires admin / super_admin via /api/admin/users.
 *
 * Even if the body carries email / role, they are silently ignored without
 * an error — preserves idempotency and is client-friendly.
 */
router.put('/profile', async (req, res) => {
  try {
    const rawName = req.body?.name;
    if (typeof rawName !== 'string') {
      return res.status(400).json({ error: '請提供 name 欄位' });
    }
    const name = rawName.trim();
    if (name.length === 0) {
      return res.status(400).json({ error: 'name 不能為空' });
    }
    if (name.length > 100) {
      return res.status(400).json({ error: 'name 長度不能超過 100 字' });
    }
    // The WHERE clause pins to req.user.id, so a body-injected id cannot
    // overwrite another user.
    const upd = await query(
      `UPDATE users SET name = $1 WHERE id = $2`,
      [name, req.user.id]
    );
    // rowCount === 0: token is still valid but the user row was already
    // deleted (race with an admin deleting the user). Returning a silent
    // 200 with fake data would mislead the client into thinking the save
    // succeeded.
    if (upd.rowCount === 0) {
      return res.status(404).json({ error: '使用者不存在' });
    }
    // Response shape mirrors GET /profile so the client can overwrite state
    // directly with what it receives.
    const r = await query(
      `SELECT must_change_password FROM users WHERE id = $1`, [req.user.id]
    );
    res.json({
      id: req.user.id,
      name,
      email: req.user.email,
      role: req.user.role,
      created_at: req.user.created_at,
      must_change_password: !!r.rows[0]?.must_change_password,
    });
  } catch (err) {
    logger.error('me/profile PUT failed', {
      error: err.message,
      stack: err.stack,
      user_id: req.user?.id,
    });
    res.status(500).json({ error: '更新個人資料失敗' });
  }
});

/**
 * GET /report?range=14d — main usage-report aggregator endpoint.
 * Defaults to 14 days; switchable via ?range=7d/30d/all.
 */
router.get('/report', async (req, res) => {
  try {
    // v1.17.34: support a custom range via ?start=YYYY-MM-DD&end=YYYY-MM-DD;
    // otherwise fall back to the ?range=Xd preset.
    const range = String(req.query.range || '14d');
    const start = String(req.query.start || '');
    const end = String(req.query.end || '');
    const ISO = /^\d{4}-\d{2}-\d{2}$/;

    // Either both start+end pass format validation → use BETWEEN; otherwise
    // use the INTERVAL preset.
    // Direct string interpolation is used, but both sides are whitelist-
    // validated for format (no injection risk).
    let timeFilter;
    if (ISO.test(start) && ISO.test(end)) {
      // Add a day to end so the whole day is included.
      timeFilter = `BETWEEN '${start}'::timestamptz AND ('${end}'::date + INTERVAL '1 day')`;
    } else {
      const interval = ({
        '7d': "7 days",
        '14d': "14 days",
        '30d': "30 days",
        'all': "100 years",
      })[range] || "14 days";
      timeFilter = `>= NOW() - INTERVAL '${interval}'`;
    }

    const me = req.user;

    // ── Personal section ──
    const myStatsQ = await query(`
      SELECT
        COUNT(*) FILTER (WHERE event = 'init') AS sessions,
        COUNT(*) AS events,
        MAX(ts) AS last_activity
      FROM activity_logs
      WHERE user_id = $1 AND ts ${timeFilter}`,
      [me.id]
    );
    const myStats = myStatsQ.rows[0];

    const myVersionsQ = await query(`
      SELECT tool, scanner_version AS version, last_reported_at
      FROM collector_heartbeat
      WHERE user_id = $1
      ORDER BY tool`,
      [me.id]
    );

    // v1.17.34: normalize project names via LOWER(TRIM(...)) so
    // 'ownmind' / 'OwnMind' merge into the same row.
    // v1.17.56: REGEXP_REPLACE strips trailing "(...)" descriptions so
    // "ai_kol" and "ai_kol (xxx)" don't split into two rows.
    const myProjectsQ = await query(`
      SELECT LOWER(TRIM(REGEXP_REPLACE(details->>'project', '\\s*[\\(（].*$', ''))) AS project_key,
        MIN(REGEXP_REPLACE(details->>'project', '\\s*[\\(（].*$', '')) AS project,
        COUNT(*) AS sessions,
        SUM(COALESCE((details->>'duration_turns')::int, 0)) AS turns
      FROM session_logs
      WHERE user_id = $1
        AND created_at ${timeFilter}
        AND details->>'project' IS NOT NULL
        AND TRIM(details->>'project') != ''
      GROUP BY project_key
      ORDER BY turns DESC NULLS LAST`,
      [me.id]
    );

    // Iron-rule compliance: list every active iron rule with the user's
    // compliance stats (LEFT JOIN).
    // v1.17.41: separate observed (system auto-observation) into its own
    // column, distinct from AI manual comply.
    // Honesty: system_auto does not count as "complied"; it only counts as
    // "the system saw a trigger".
    const myComplianceQ = await query(`
      WITH stats AS (
        SELECT details->>'rule_code' AS rule_code,
          COUNT(*) FILTER (
            WHERE details->>'action' = 'comply'
              AND COALESCE(details->>'source', '') NOT LIKE 'system_%'
          ) AS comply,
          COUNT(*) FILTER (
            WHERE details->>'action' = 'skip'
              AND COALESCE(details->>'source', '') NOT LIKE 'system_%'
          ) AS skip,
          COUNT(*) FILTER (
            WHERE details->>'action' = 'violate'
          ) AS violate,
          COUNT(*) FILTER (
            WHERE details->>'action' = 'observed_trigger'
              OR (COALESCE(details->>'source', '') LIKE 'system_%'
                  AND details->>'action' = 'comply')
          ) AS observed
        FROM activity_logs
        WHERE user_id = $1
          AND event = 'iron_rule_compliance'
          AND ts ${timeFilter}
        GROUP BY rule_code
      )
      SELECT m.code AS rule_code, m.title,
        COALESCE(s.comply, 0) AS comply,
        COALESCE(s.skip, 0) AS skip,
        COALESCE(s.violate, 0) AS violate,
        COALESCE(s.observed, 0) AS observed
      FROM memories m
      LEFT JOIN stats s ON s.rule_code = m.code
      WHERE m.type = 'iron_rule' AND m.status = 'active' AND m.code IS NOT NULL
      ORDER BY (COALESCE(s.comply,0) + COALESCE(s.skip,0) + COALESCE(s.violate,0) + COALESCE(s.observed,0)) DESC,
        m.code ASC`,
      [me.id]
    );

    // Personal activity log (everything in the time window; the front-end
    // paginates).
    // v1.17.33: removed LIMIT 200 — user feedback: "the log should show
    // everything in the time window".
    const myActivityQ = await query(`
      SELECT ts, event, tool, source, details
      FROM activity_logs
      WHERE user_id = $1
        AND ts ${timeFilter}
      ORDER BY ts DESC`,
      [me.id]
    );

    // ── Team section (Q1=C fully open) ──
    // v1.17.35: added tokens / turns as alternate metrics the front-end can toggle.
    const teamUsersQ = await query(`
      SELECT u.id, u.name, u.email, u.role,
        COUNT(*) FILTER (WHERE al.event = 'init') AS sessions,
        COUNT(al.id) AS events,
        MAX(al.ts) AS last_activity,
        COALESCE((SELECT SUM(input_tokens + output_tokens + cache_creation_tokens
                            + cache_read_tokens + reasoning_tokens)
                  FROM token_events te
                  WHERE te.user_id = u.id AND te.ts ${timeFilter}), 0) AS tokens,
        COALESCE((SELECT SUM(COALESCE((details->>'duration_turns')::int, 0))
                  FROM session_logs sl
                  WHERE sl.user_id = u.id AND sl.created_at ${timeFilter}), 0) AS turns
      FROM users u
      LEFT JOIN activity_logs al ON al.user_id = u.id
        AND al.ts ${timeFilter}
      GROUP BY u.id, u.name, u.email, u.role
      ORDER BY events DESC NULLS LAST`
    );

    // v1.17.35: all three trend charts also include tokens / turns
    // (activity count remains the default). Use FULL OUTER JOIN to merge
    // the three datasets without missing buckets.
    const dailyTrendQ = await query(`
      WITH a AS (
        SELECT to_char(ts AT TIME ZONE 'Asia/Taipei', 'MM-DD') AS d,
          COUNT(*) AS sessions
        FROM activity_logs WHERE ts ${timeFilter} GROUP BY d
      ), t AS (
        SELECT to_char(ts AT TIME ZONE 'Asia/Taipei', 'MM-DD') AS d,
          SUM(input_tokens + output_tokens + cache_creation_tokens
              + cache_read_tokens + reasoning_tokens) AS tokens
        FROM token_events WHERE ts ${timeFilter} GROUP BY d
      ), s AS (
        SELECT to_char(created_at AT TIME ZONE 'Asia/Taipei', 'MM-DD') AS d,
          SUM(COALESCE((details->>'duration_turns')::int, 0)) AS turns
        FROM session_logs WHERE created_at ${timeFilter} GROUP BY d
      )
      SELECT COALESCE(a.d, t.d, s.d) AS d,
        COALESCE(a.sessions, 0) AS sessions,
        COALESCE(t.tokens, 0) AS tokens,
        COALESCE(s.turns, 0) AS turns
      FROM a FULL OUTER JOIN t ON a.d = t.d FULL OUTER JOIN s ON COALESCE(a.d, t.d) = s.d
      ORDER BY d`
    );

    const hourlyTrendQ = await query(`
      WITH a AS (
        SELECT EXTRACT(HOUR FROM ts AT TIME ZONE 'Asia/Taipei')::int AS hour,
          COUNT(*) AS sessions
        FROM activity_logs WHERE ts ${timeFilter} GROUP BY hour
      ), t AS (
        SELECT EXTRACT(HOUR FROM ts AT TIME ZONE 'Asia/Taipei')::int AS hour,
          SUM(input_tokens + output_tokens + cache_creation_tokens
              + cache_read_tokens + reasoning_tokens) AS tokens
        FROM token_events WHERE ts ${timeFilter} GROUP BY hour
      ), s AS (
        SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Taipei')::int AS hour,
          SUM(COALESCE((details->>'duration_turns')::int, 0)) AS turns
        FROM session_logs WHERE created_at ${timeFilter} GROUP BY hour
      )
      SELECT COALESCE(a.hour, t.hour, s.hour) AS hour,
        COALESCE(a.sessions, 0) AS sessions,
        COALESCE(t.tokens, 0) AS tokens,
        COALESCE(s.turns, 0) AS turns
      FROM a FULL OUTER JOIN t ON a.hour = t.hour FULL OUTER JOIN s ON COALESCE(a.hour, t.hour) = s.hour
      ORDER BY hour`
    );

    const weekdayTrendQ = await query(`
      WITH a AS (
        SELECT EXTRACT(DOW FROM ts AT TIME ZONE 'Asia/Taipei')::int AS dow,
          COUNT(*) AS sessions
        FROM activity_logs WHERE ts ${timeFilter} GROUP BY dow
      ), t AS (
        SELECT EXTRACT(DOW FROM ts AT TIME ZONE 'Asia/Taipei')::int AS dow,
          SUM(input_tokens + output_tokens + cache_creation_tokens
              + cache_read_tokens + reasoning_tokens) AS tokens
        FROM token_events WHERE ts ${timeFilter} GROUP BY dow
      ), s AS (
        SELECT EXTRACT(DOW FROM created_at AT TIME ZONE 'Asia/Taipei')::int AS dow,
          SUM(COALESCE((details->>'duration_turns')::int, 0)) AS turns
        FROM session_logs WHERE created_at ${timeFilter} GROUP BY dow
      )
      SELECT COALESCE(a.dow, t.dow, s.dow) AS dow,
        COALESCE(a.sessions, 0) AS sessions,
        COALESCE(t.tokens, 0) AS tokens,
        COALESCE(s.turns, 0) AS turns
      FROM a FULL OUTER JOIN t ON a.dow = t.dow FULL OUTER JOIN s ON COALESCE(a.dow, t.dow) = s.dow
      ORDER BY dow`
    );

    const eventTypesQ = await query(`
      SELECT event, COUNT(*) AS count
      FROM activity_logs
      WHERE ts ${timeFilter}
      GROUP BY event ORDER BY count DESC LIMIT 15`
    );

    const allVersionsQ = await query(`
      SELECT u.name, u.id AS user_id, h.tool, h.scanner_version AS version, h.last_reported_at
      FROM collector_heartbeat h
      JOIN users u ON u.id = h.user_id
      WHERE h.last_reported_at >= NOW() - INTERVAL '14 days'
      ORDER BY u.name, h.tool`
    );

    // ── Project section (Q2=B all team projects visible) ──
    // v1.17.30: switched to per-user details so primary owners and division
    // of labor are visible.
    // v1.17.34: normalize project names via LOWER(TRIM(...)) to merge
    // case variants.
    // v1.17.36: multi-source merge — session_logs (quantitative data) +
    //   handoffs (also a signal of activity; some work has handoffs but
    //   no session_log, e.g. the ProjectR project).
    // v1.17.56: REGEXP_REPLACE strips trailing "(...)" descriptions.
    const projectContribQ = await query(`
      SELECT LOWER(TRIM(REGEXP_REPLACE(details->>'project', '\\s*[\\(（].*$', ''))) AS project_key,
        MIN(REGEXP_REPLACE(details->>'project', '\\s*[\\(（].*$', '')) AS project,
        u.name,
        COUNT(*) AS sessions,
        SUM(COALESCE((details->>'duration_turns')::int, 0)) AS turns
      FROM session_logs sl
      JOIN users u ON u.id = sl.user_id
      WHERE sl.created_at ${timeFilter}
        AND details->>'project' IS NOT NULL
        AND TRIM(details->>'project') != ''
      GROUP BY project_key, u.name
      ORDER BY project_key, 5 DESC NULLS LAST`
    );
    // Handoff supplement (projects with handoffs but no session_log).
    const projectHandoffQ = await query(`
      SELECT LOWER(TRIM(h.project)) AS project_key,
        MIN(h.project) AS project,
        u.name,
        COUNT(*) AS handoffs
      FROM handoffs h
      JOIN users u ON u.id = h.user_id
      WHERE h.created_at ${timeFilter}
        AND h.project IS NOT NULL
        AND TRIM(h.project) != ''
      GROUP BY project_key, u.name`
    );
    const projMap = new Map();
    for (const r of projectContribQ.rows) {
      const t = parseInt(r.turns, 10) || 0;
      const s = parseInt(r.sessions, 10) || 0;
      const key = r.project_key;
      if (!projMap.has(key)) {
        projMap.set(key, { project: r.project, sessions: 0, turns: 0, handoffs: 0, contributors: [] });
      }
      const e = projMap.get(key);
      e.sessions += s;
      e.turns += t;
      e.contributors.push({ name: r.name, sessions: s, turns: t, handoffs: 0 });
    }
    // Merge handoff counts; if a project did not appear in session_logs
    // before, create the entry now.
    for (const r of projectHandoffQ.rows) {
      const h = parseInt(r.handoffs, 10) || 0;
      const key = r.project_key;
      if (!projMap.has(key)) {
        projMap.set(key, { project: r.project, sessions: 0, turns: 0, handoffs: 0, contributors: [] });
      }
      const e = projMap.get(key);
      e.handoffs += h;
      // Find the user's contributor entry; create one if missing.
      let contrib = e.contributors.find(c => c.name === r.name);
      if (!contrib) {
        contrib = { name: r.name, sessions: 0, turns: 0, handoffs: 0 };
        e.contributors.push(contrib);
      }
      contrib.handoffs += h;
    }
    // Sort: turns first (primary quantitative metric), tie-break on
    // handoffs, then sessions.
    const teamProjects = Array.from(projMap.values())
      .sort((a, b) => b.turns - a.turns || b.handoffs - a.handoffs || b.sessions - a.sessions);

    const teamComplianceQ = await query(`
      SELECT details->>'rule_code' AS rule_code,
        COUNT(*) FILTER (WHERE details->>'action' = 'comply') AS comply,
        COUNT(*) FILTER (WHERE details->>'action' = 'skip') AS skip,
        COUNT(*) FILTER (WHERE details->>'action' = 'violate') AS violate,
        COUNT(DISTINCT user_id) AS reporters
      FROM activity_logs
      WHERE event = 'iron_rule_compliance'
        AND ts ${timeFilter}
      GROUP BY rule_code
      ORDER BY COUNT(*) DESC`
    );

    // ── Server-side reverse audit (since v1.17.38) ──
    // Improvements after the Codex round-3 review (v1.17.39):
    //   P1.1 orphan_session gated by the v1.17.37 ship date.
    //   P1.2 compliance_gap narrows the sensitive-event list + uses
    //         verification metadata.
    //   P2.1 heartbeat compares tools via LOWER().
    const V17_37_SHIPPED = '2026-05-07';  // From v1.17.37 onward, emergencySessionLog auto-attaches a compliance array.

    // #1 activity/compliance gap. v1.17.42 splits this into two severities:
    //   gap_a "unobserved": no compliance event at all (even system
    //     observation missed it → system is broken).
    //   gap_b "unverified": system_auto observed_trigger exists but no
    //     matching iron-rule manual comply.
    // v1.17.43: has_manual_comply also matches by rule_code so unrelated
    //   comply rows don't accidentally clear the gap.
    //   Each sensitive event has a list of expected_rules.
    const complianceGapQ = await query(`
      WITH sensitive AS (
        -- v1.17.87: dropped handoff_create (aligned with activity.js's
        -- autoEmitObservedTrigger design choice — handoff content is the
        -- user's subjective input and should not be treated as a compliance
        -- trigger). The two remaining events are clear "modifying iron
        -- rules" triggers for IR-006.
        SELECT id, ts,
          CASE
            WHEN event = 'memory_disable' THEN ARRAY['IR-006']
            WHEN event = 'memory_save' AND details->>'type' = 'iron_rule' THEN ARRAY['IR-006']
          END AS expected_rules
        FROM activity_logs
        WHERE user_id = $1 AND ts ${timeFilter}
          AND (
            event = 'memory_disable'
            OR (event = 'memory_save' AND details->>'type' = 'iron_rule')
          )
      ),
      classified AS (
        SELECT s.id,
          EXISTS (
            SELECT 1 FROM activity_logs c
            WHERE c.user_id = $1 AND c.event = 'iron_rule_compliance'
              AND c.ts BETWEEN s.ts - INTERVAL '10 minutes' AND s.ts + INTERVAL '10 minutes'
          ) AS has_any,
          EXISTS (
            SELECT 1 FROM activity_logs c
            WHERE c.user_id = $1 AND c.event = 'iron_rule_compliance'
              AND c.ts BETWEEN s.ts - INTERVAL '10 minutes' AND s.ts + INTERVAL '10 minutes'
              AND c.details->>'action' = 'comply'
              -- v1.17.45: exclude any system_* automatic source (client + server).
              AND COALESCE(c.details->>'source', '') NOT LIKE 'system_%'
              AND c.details->>'rule_code' = ANY(s.expected_rules)
          ) AS has_matching_manual_comply
        FROM sensitive s
      )
      SELECT
        COUNT(*) FILTER (WHERE NOT has_any) AS gap_unobserved,
        COUNT(*) FILTER (WHERE has_any AND NOT has_matching_manual_comply) AS gap_unverified
      FROM classified`,
      [me.id]
    );

    // #3 heartbeat absence: compare tool names via LOWER(TRIM(...)) so case
    // variations don't slip through.
    const heartbeatAuditQ = await query(`
      WITH active AS (
        SELECT DISTINCT LOWER(TRIM(tool)) AS tool_key, MIN(tool) AS tool
        FROM activity_logs
        WHERE user_id = $1 AND ts >= NOW() - INTERVAL '7 days'
          AND tool IS NOT NULL AND tool NOT IN ('unknown', 'mcp')
        GROUP BY tool_key
      ),
      hb AS (
        SELECT LOWER(TRIM(tool)) AS tool_key, MAX(last_reported_at) AS last_hb
        FROM collector_heartbeat WHERE user_id = $1
        GROUP BY tool_key
      )
      SELECT a.tool, hb.last_hb,
        EXTRACT(EPOCH FROM (NOW() - hb.last_hb)) / 3600 AS stale_hours
      FROM active a LEFT JOIN hb ON a.tool_key = hb.tool_key
      WHERE hb.last_hb IS NULL OR hb.last_hb < NOW() - INTERVAL '24 hours'`,
      [me.id]
    );

    // #4 cross-source consistency: flag days with activity but zero
    // token_events.
    // Skip the "this tool has no token scanner" case: only look at tools
    // present in collector_heartbeat.
    const consistencyQ = await query(`
      WITH days AS (
        SELECT DISTINCT to_char(ts AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS d
        FROM activity_logs WHERE user_id = $1 AND ts ${timeFilter}
      ),
      tok_days AS (
        SELECT DISTINCT to_char(ts AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS d
        FROM token_events WHERE user_id = $1 AND ts ${timeFilter}
      ),
      has_scanner AS (
        SELECT EXISTS(SELECT 1 FROM collector_heartbeat WHERE user_id = $1) AS yes
      )
      SELECT COUNT(*) AS missing_days FROM days d, has_scanner h
      WHERE h.yes = TRUE
        AND NOT EXISTS (SELECT 1 FROM tok_days t WHERE t.d = d.d)`,
      [me.id]
    );

    // #2 orphan session compliance: only since v1.17.37 ship do sessions
    // auto-write a compliance array. Date-gated to avoid historical noise.
    const orphanComplianceQ = await query(`
      SELECT COUNT(*) AS orphan_count
      FROM session_logs
      WHERE user_id = $1
        AND created_at ${timeFilter}
        AND created_at >= '${V17_37_SHIPPED}'::timestamptz
        AND (
          details->'compliance' IS NULL
          OR jsonb_array_length(details->'compliance') = 0
        )
        AND COALESCE((details->>'duration_turns')::int, 0) >= 5`,
      [me.id]
    );

    // P3: blind-spot detection — the user has an OwnMind account but no MCP
    // activity at all. They may be using a non-MCP surface (claude.ai web,
    // ChatGPT), which is entirely unobservable.
    const blindSpotQ = await query(`
      SELECT
        (SELECT COUNT(*) FROM activity_logs WHERE user_id = $1 AND ts >= NOW() - INTERVAL '14 days') AS recent_activity,
        (SELECT COUNT(*) FROM token_events WHERE user_id = $1 AND ts >= NOW() - INTERVAL '14 days') AS recent_tokens,
        (SELECT MAX(last_reported_at) FROM collector_heartbeat WHERE user_id = $1) AS latest_hb,
        EXTRACT(EPOCH FROM (NOW() - $2::timestamptz)) / 86400 AS account_age_days`,
      [me.id, me.created_at]
    );

    // Assemble audit_findings for the front-end.
    // v1.17.87: dropped the three compliance warnings from the personal page
    // (compliance_unobserved / compliance_unverified / orphan_session).
    // Reasons:
    //   1. These reflect system bugs or AI behavior problems, not something
    //      individual users should fret about.
    //   2. The patterns only emerge across users (e.g. "all 9 rows come
    //      from 3 handlers").
    //   3. Moved to the new GET /api/pitfalls endpoint + me.html "pitfalls"
    //      tab, presented cross-user; any user can see it.
    // Kept: heartbeat_absent / source_inconsistent / unobservable_source —
    // these are about the user's own environment (scanner not running, not
    // using MCP tools) and rightly belong on the personal page.
    const myAuditFindings = [];
    const heartbeatStale = heartbeatAuditQ.rows;
    if (heartbeatStale.length > 0) {
      myAuditFindings.push({
        type: 'heartbeat_absent',
        severity: 'high',
        count: heartbeatStale.length,
        message: `${heartbeatStale.length} 個工具最近有活動但 collector heartbeat 超過 24 小時沒回報，token 用量資料可能不完整`,
        details: { tools: heartbeatStale.map(r => r.tool) },
      });
    }
    const missingDays = parseInt(consistencyQ.rows[0]?.missing_days, 10) || 0;
    if (missingDays > 0) {
      myAuditFindings.push({
        type: 'source_inconsistent',
        severity: missingDays > 3 ? 'medium' : 'low',
        count: missingDays,
        message: `${missingDays} 天有 activity 紀錄但完全沒有 token_events，scanner 可能沒在跑`,
      });
    }
    // v1.17.87: orphan_session also moved to /api/pitfalls for cross-user
    // presentation; no longer warned on the personal page.

    // P3: blind-spot — account is >7 days old but with no MCP activity.
    const bs = blindSpotQ.rows[0];
    if (parseFloat(bs.account_age_days || 0) > 7
      && parseInt(bs.recent_activity, 10) === 0
      && parseInt(bs.recent_tokens, 10) === 0
      && !bs.latest_hb) {
      myAuditFindings.push({
        type: 'unobservable_source',
        severity: 'medium',
        count: 1,
        message: `帳號開立 ${Math.round(parseFloat(bs.account_age_days))} 天，但 14 天內 0 個 MCP activity / token / heartbeat。可能：(a) 完全沒在用 (b) 用非 MCP 介面（claude.ai web / ChatGPT）做事，OwnMind 整段不可觀測`,
      });
    }

    // #5 IR-027 reverse audit (super_admin only):
    // user created > 7 days ago, still on a default password
    // (must_change_password=TRUE).
    if (me.role === 'super_admin') {
      const ir027Q = await query(`
        SELECT u.id, u.email,
          EXTRACT(EPOCH FROM (NOW() - u.created_at)) / 86400 AS age_days,
          u.must_change_password
        FROM users u
        WHERE u.role = 'user'
          AND u.must_change_password = TRUE
          AND u.created_at < NOW() - INTERVAL '7 days'
      `);
      if (ir027Q.rows.length > 0) {
        myAuditFindings.push({
          type: 'ir027_candidate',
          severity: 'medium',
          count: ir027Q.rows.length,
          message: `${ir027Q.rows.length} 位 user 建立超過 7 天仍是預設密碼，可能根本沒登入過 /ownmind/me/`,
          details: { emails: ir027Q.rows.map(r => r.email) },
        });
      }

      // P3 admin view: find team members who might be using a non-MCP surface.
      const teamBlindQ = await query(`
        SELECT u.email, u.name
        FROM users u
        WHERE u.role IN ('user', 'admin')
          AND u.created_at < NOW() - INTERVAL '7 days'
          AND NOT EXISTS (
            SELECT 1 FROM activity_logs WHERE user_id = u.id
              AND ts >= NOW() - INTERVAL '14 days'
          )
          AND NOT EXISTS (
            SELECT 1 FROM token_events WHERE user_id = u.id
              AND ts >= NOW() - INTERVAL '14 days'
          )
      `);
      if (teamBlindQ.rows.length > 0) {
        myAuditFindings.push({
          type: 'team_blindspot',
          severity: 'low',
          count: teamBlindQ.rows.length,
          message: `${teamBlindQ.rows.length} 位 team 成員 14 天內無任何 MCP / token 訊號，OwnMind 對其工作完全不可觀測`,
          details: { members: teamBlindQ.rows.map(r => r.name + ' (' + r.email + ')') },
        });
      }
    }

    // P2.2: persist into the audit_logs table (only high severity, to avoid
    // noise). Reuses the audit_logs schema with actor_id=system(0),
    // action='audit_finding', target_type='user'. Persisting lets background
    // monitoring / email / broadcast hook into this later (today we just
    // record; notification wiring comes later).
    for (const f of myAuditFindings) {
      if (f.severity === 'high') {
        // De-dupe within 24h on the same user / type (coarse dedup).
        try {
          await query(`
            INSERT INTO audit_logs (actor_id, action, target_type, target_id, details)
            SELECT NULL, 'audit_finding', 'user', $1, $2::jsonb
            WHERE NOT EXISTS (
              SELECT 1 FROM audit_logs
              WHERE action = 'audit_finding' AND target_id = $1
                AND details->>'type' = $3
                AND created_at > NOW() - INTERVAL '24 hours'
            )
          `, [me.id, JSON.stringify(f), f.type]);
        } catch (e) {
          // Silent fail — don't block report generation.
          logger.warn('audit_finding persistence failed', { error: e.message });
        }
      }
    }

    res.json({
      range,
      generated_at: new Date().toISOString(),
      me: {
        id: me.id,
        name: me.name,
        role: me.role,
        sessions: parseInt(myStats.sessions, 10) || 0,
        events: parseInt(myStats.events, 10) || 0,
        last_activity: myStats.last_activity,
        versions: myVersionsQ.rows,
        projects: myProjectsQ.rows,
        compliance: myComplianceQ.rows.map(r => ({
          rule_code: r.rule_code,
          title: r.title,
          comply: parseInt(r.comply, 10) || 0,
          skip: parseInt(r.skip, 10) || 0,
          violate: parseInt(r.violate, 10) || 0,
          observed: parseInt(r.observed, 10) || 0,
        })),
        activity: myActivityQ.rows,
        audit_findings: myAuditFindings,
      },
      team: {
        users: teamUsersQ.rows.map(r => ({
          ...r,
          sessions: parseInt(r.sessions, 10) || 0,
          events: parseInt(r.events, 10) || 0,
          tokens: parseInt(r.tokens, 10) || 0,
          turns: parseInt(r.turns, 10) || 0,
        })),
        daily_trend: dailyTrendQ.rows.map(r => ({
          d: r.d,
          sessions: parseInt(r.sessions, 10) || 0,
          tokens: parseInt(r.tokens, 10) || 0,
          turns: parseInt(r.turns, 10) || 0,
        })),
        hourly_trend: hourlyTrendQ.rows.map(r => ({
          hour: r.hour,
          sessions: parseInt(r.sessions, 10) || 0,
          tokens: parseInt(r.tokens, 10) || 0,
          turns: parseInt(r.turns, 10) || 0,
        })),
        weekday_trend: weekdayTrendQ.rows.map(r => ({
          dow: r.dow,
          sessions: parseInt(r.sessions, 10) || 0,
          tokens: parseInt(r.tokens, 10) || 0,
          turns: parseInt(r.turns, 10) || 0,
        })),
        event_types: eventTypesQ.rows.map(r => ({ event: r.event, count: parseInt(r.count, 10) })),
        versions: allVersionsQ.rows,
        compliance: teamComplianceQ.rows,
      },
      projects: teamProjects,
    });
  } catch (err) {
    logger.error('me/report failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: '報告產生失敗' });
  }
});

// =========================================================================
// v1.17.87 — GET /api/me/pitfalls: cross-user pitfalls log (visible to any user).
// =========================================================================
//
// Design: moved the three compliance warnings from the /me/report personal
// page (compliance_unobserved / compliance_unverified / orphan_session)
// into a cross-user aggregated "pitfalls" tab.
//
// Why visible to any user:
//   - These are "system bugs or AI behavior problems", not individual privacy.
//   - The patterns only emerge across users (9 rows all from 3 handlers).
//   - Per Vin's spec: every user should see "OwnMind's overall audit health".
//
// Query params:
//   - window: 7d / 30d / 90d / all (default 30d)
//   - status: pending / resolved / wontfix / all (default pending) —
//     v1.17.87 P1 returns pending only for now; later we'll add a mutation
//     endpoint to change status.
//
// Returns three sections:
//   - unobserved: high-risk actions with no compliance record (system bug).
//   - unverified: system observed but AI didn't proactively report (AI behavior).
//   - orphan_session: ≥5-turn sessions with no compliance (whole session unreported).
//
// Each row has four fields: when / what / impact / fix_hint.
router.get('/pitfalls', async (req, res) => {
  try {
    // window param.
    const window = req.query.window || '30d';
    let timeFilter;
    if (window === 'all') {
      timeFilter = `>= '2025-01-01'::timestamptz`;
    } else {
      const days = { '7d': 7, '30d': 30, '90d': 90 }[window] || 30;
      timeFilter = `>= NOW() - INTERVAL '${days} days'`;
    }

    // v1.17.92 → v1.17.93: V17_87_SHIPPED cutoff revert.
    //   v1.17.92 added the cutoff as a workaround — hides 8 v1.17.87
    //   historical leftovers but the data still lives in the DB, which
    //   violates "transparency" + IR-027 (reminders are useless, only logic
    //   counts). v1.17.93 reverts the cutoff and leaves the 8 visible.
    //   Use a fix_hint to explain clearly:
    //   - It's v1.17.87 pre-ship history (memory.js POST didn't write a
    //     server-side compliance row at that time).
    //   - It cannot be backfilled (fake audit logs would taint the audit).
    //   - It disappears naturally after the 14-day retention.
    //   Admins see this and immediately understand "not a current bug, no
    //   action needed".

    // ── Section 1: unobserved (no compliance log within ±10 minutes of a
    //   high-risk action) ──
    //
    // v1.17.90: memory_disable branch adds an iron_rule type filter.
    //   Background: of the 30 unobserved rows in v1.17.88, 22 (73%) were
    //   team_standard / standard_detail / project disables miscounted as
    //   sensitive. team_standard etc. disables should not trigger IR-006.
    //   First read details->>'disabled_type' (written by v1.17.89+
    //   enrichActivityDetails); fall back to JOIN memories for older data
    //   from before v1.17.89 (which naturally expires within 14 days).
    const unobservedQ = await query(`
      WITH sensitive AS (
        SELECT a.id, a.ts, a.user_id, a.event, a.details,
          CASE
            WHEN a.event = 'memory_disable' THEN ARRAY['IR-006']
            WHEN a.event = 'memory_save' AND a.details->>'type' = 'iron_rule' THEN ARRAY['IR-006']
          END AS expected_rules
        FROM activity_logs a
        WHERE a.ts ${timeFilter}
          AND (
            (a.event = 'memory_disable'
              AND COALESCE(
                a.details->>'disabled_type',
                (SELECT type FROM memories WHERE id = (CASE WHEN a.details->>'id' ~ '^\d+$' THEN (a.details->>'id')::int END))
              ) = 'iron_rule')
            OR (a.event = 'memory_save' AND a.details->>'type' = 'iron_rule')
          )
      )
      SELECT
        s.id, s.ts, s.user_id, s.event, s.expected_rules,
        u.name AS user_name,
        s.details->>'title' AS save_title,
        s.details->>'id' AS disabled_memory_id,
        -- v1.17.89: prefer the details snapshot (new data, written by
        -- enrichActivityDetails); fall back to JOIN memories for older
        -- pre-v1.17.88 data, which naturally expires in 14 days.
        COALESCE(
          s.details->>'disabled_title',
          (SELECT title FROM memories WHERE id = (CASE WHEN s.details->>'id' ~ '^\d+$' THEN (s.details->>'id')::int END))
        ) AS disabled_title,
        COALESCE(
          s.details->>'disabled_code',
          (SELECT code FROM memories WHERE id = (CASE WHEN s.details->>'id' ~ '^\d+$' THEN (s.details->>'id')::int END))
        ) AS disabled_code
      FROM sensitive s
      JOIN users u ON u.id = s.user_id
      WHERE NOT EXISTS (
        SELECT 1 FROM activity_logs c
        WHERE c.user_id = s.user_id
          AND c.event = 'iron_rule_compliance'
          AND c.ts BETWEEN s.ts - INTERVAL '10 minutes' AND s.ts + INTERVAL '10 minutes'
      )
      ORDER BY s.ts DESC`);

    // ── Section 2: unverified (system observed but no matching manual
    //   comply) ──
    // v1.17.90: same logic as unobserved; memory_disable filter requires
    // iron_rule type.
    const unverifiedQ = await query(`
      WITH sensitive AS (
        SELECT a.id, a.ts, a.user_id, a.event, a.details,
          CASE
            WHEN a.event = 'memory_disable' THEN ARRAY['IR-006']
            WHEN a.event = 'memory_save' AND a.details->>'type' = 'iron_rule' THEN ARRAY['IR-006']
          END AS expected_rules
        FROM activity_logs a
        WHERE a.ts ${timeFilter}
          AND (
            (a.event = 'memory_disable'
              AND COALESCE(
                a.details->>'disabled_type',
                (SELECT type FROM memories WHERE id = (CASE WHEN a.details->>'id' ~ '^\d+$' THEN (a.details->>'id')::int END))
              ) = 'iron_rule')
            OR (a.event = 'memory_save' AND a.details->>'type' = 'iron_rule')
          )
      )
      SELECT
        s.id, s.ts, s.user_id, s.event, s.expected_rules,
        u.name AS user_name,
        s.details->>'title' AS save_title,
        s.details->>'id' AS disabled_memory_id,
        -- v1.17.89: prefer details snapshot; fall back to JOIN memories.
        COALESCE(
          s.details->>'disabled_title',
          (SELECT title FROM memories WHERE id = (CASE WHEN s.details->>'id' ~ '^\d+$' THEN (s.details->>'id')::int END))
        ) AS disabled_title
      FROM sensitive s
      JOIN users u ON u.id = s.user_id
      WHERE EXISTS (
        SELECT 1 FROM activity_logs c1
        WHERE c1.user_id = s.user_id
          AND c1.event = 'iron_rule_compliance'
          AND c1.ts BETWEEN s.ts - INTERVAL '10 minutes' AND s.ts + INTERVAL '10 minutes'
      )
      AND NOT EXISTS (
        SELECT 1 FROM activity_logs c2
        WHERE c2.user_id = s.user_id
          AND c2.event = 'iron_rule_compliance'
          AND c2.ts BETWEEN s.ts - INTERVAL '10 minutes' AND s.ts + INTERVAL '10 minutes'
          AND c2.details->>'action' = 'comply'
          AND COALESCE(c2.details->>'source', '') NOT LIKE 'system_%'
          AND c2.details->>'rule_code' = ANY(s.expected_rules)
      )
      ORDER BY s.ts DESC`);

    // ── Section 3: orphan_session (≥5-turn session with no compliance) ──
    const V17_37_SHIPPED = '2026-05-07';
    const orphanQ = await query(`
      SELECT s.id, s.created_at AS ts, s.user_id, s.tool, s.machine,
        u.name AS user_name,
        s.details->>'project' AS project,
        COALESCE((s.details->>'duration_turns')::int, 0) AS turns,
        s.details->>'summary' AS summary
      FROM session_logs s
      JOIN users u ON u.id = s.user_id
      WHERE s.created_at ${timeFilter}
        AND s.created_at >= '${V17_37_SHIPPED}'::timestamptz
        AND (
          s.details->'compliance' IS NULL
          OR jsonb_array_length(s.details->'compliance') = 0
        )
        AND COALESCE((s.details->>'duration_turns')::int, 0) >= 5
      ORDER BY s.created_at DESC`);

    // Wrap rows into a unified shape: when / what / impact / fix_hint + details.
    const fmtUnobs = (r) => {
      const isSave = r.event === 'memory_save';
      const what = isSave
        ? `新增鐵律「${r.save_title || '(無 title)'}」`
        : `停用鐵律 ${r.disabled_code || ''}「${r.disabled_title || '(找不到)'}」`;
      return {
        type: 'unobserved',
        status: 'pending',  // v1.17.87: all pending for now; will add mutation later.
        when: r.ts,
        user_id: r.user_id,
        user_name: r.user_name,
        expected_rules: r.expected_rules || [],
        what,
        impact: `${(r.expected_rules || []).join(' / ')} 鐵律觸發但伺服器沒留稽核紀錄、admin 無法回溯查證 AI 是否遵守`,
        // v1.17.93: rewrite fix_hint to make it clear "this is historical
        // residue, no action needed", so admins don't try to manually
        // backfill compliance logs (fake audit entries taint the audit).
        fix_hint: 'v1.17.87 (2026-05-11) 已補上 memory.js POST iron_rule 路徑的 server-side observed_trigger，新事件不會再漏。剩下顯示的是 v1.17.87 之前的歷史殘留、無法補記（補假 audit log 反而汙染稽核）、14 天 retention 後自然消失、不需要處理',
        raw: { id: r.id, event: r.event },
      };
    };
    const fmtUnverif = (r) => {
      const isSave = r.event === 'memory_save';
      const what = isSave
        ? `新增鐵律「${r.save_title || '(無 title)'}」`
        : `停用鐵律「${r.disabled_title || '(找不到)'}」`;
      return {
        type: 'unverified',
        status: 'pending',
        when: r.ts,
        user_id: r.user_id,
        user_name: r.user_name,
        expected_rules: r.expected_rules || [],
        what,
        impact: '系統已觀測到觸發、但 AI 沒主動 call ownmind_report_compliance 留遵守紀錄',
        // v1.17.93: also explain historical residue + 14-day retention.
        fix_hint: 'AI 行為問題：在 SKILL.md 加指引、提醒 AI 動到鐵律時要主動 call compliance。v1.17.87 (2026-05-11) 之前的舊事件無法補記、14 天 retention 後自然消失',
        raw: { id: r.id, event: r.event },
      };
    };
    const fmtOrphan = (r) => ({
      type: 'orphan_session',
      status: 'pending',
      when: r.ts,
      user_id: r.user_id,
      user_name: r.user_name,
      what: `Session #${r.id} on ${r.tool || '?'} (${r.turns} 輪, 專案：${r.project || '-'})`,
      impact: '高互動 session 整段沒留任何 compliance call、AI 可能整段都沒回報鐵律遵守',
      fix_hint: '過去事件、無需手動處理；自然過期。AI 行為層面可加 session 末端 compliance summary',
      // v1.17.87 reviewer #3: raw.summary is another user's session content
      // and would leak across users. Truncate to 40 chars so the pitfall
      // entry conveys rough context without exposing the full message
      // (pitfalls are pattern-spotting, not content disclosure).
      raw: {
        id: r.id, tool: r.tool, machine: r.machine,
        summary: r.summary ? String(r.summary).slice(0, 40) + (r.summary.length > 40 ? '…' : '') : null,
      },
    });

    res.json({
      window,
      generated_at: new Date().toISOString(),
      sections: {
        unobserved: {
          count: unobservedQ.rows.length,
          rows: unobservedQ.rows.map(fmtUnobs),
        },
        unverified: {
          count: unverifiedQ.rows.length,
          rows: unverifiedQ.rows.map(fmtUnverif),
        },
        orphan_session: {
          count: orphanQ.rows.length,
          rows: orphanQ.rows.map(fmtOrphan),
        },
      },
    });
  } catch (err) {
    logger.error('me/pitfalls failed', { error: err.message, stack: err.stack });
    res.status(500).json({ error: '踩坑紀錄查詢失敗' });
  }
});

export default router;
