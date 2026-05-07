/**
 * /api/me — User-accessible 用量報告 endpoint（v1.17.24）
 *
 * 開放給任意 role（user / admin / super_admin）使用，提供：
 *   - GET /profile — 用 api_key 驗身份，回最少資料
 *   - GET /report — 個人 + 團隊 + 專案 三大區塊聚合資料
 *
 * 設計決策：
 *   - 用一般 auth middleware（一般版，不擋 user role）
 *   - Q1=C 完全開放，無匿名化（互看版本／活動）
 *   - Q2=B 全團隊專案都看得到（不含對話內容）
 */

import { Router } from 'express';
import bcrypt from 'bcrypt';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = Router();
const BCRYPT_ROUNDS = 10;

/**
 * POST /api/me/login — email + password 登入（v1.17.25 起接受任意 role）
 * 成功回 api_key + must_change_password flag
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
    logger.error('me/login 失敗', { error: err.message });
    res.status(500).json({ error: '登入失敗' });
  }
});

// 以下 endpoint 都需 Bearer api_key auth（任意 role）
router.use(auth);

/**
 * POST /api/me/change-password — 修改自己密碼
 * Body: { current_password, new_password }
 * must_change_password 旗標自動清掉
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
      return res.status(401).json({ error: '舊密碼錯誤' });
    }
    const hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    await query(
      `UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2`,
      [hash, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error('me/change-password 失敗', { error: err.message });
    res.status(500).json({ error: '修改密碼失敗' });
  }
});

/**
 * GET /profile — 驗 api_key，回身份摘要
 * 前端拿來確認 key 有效 + 顯示 user 名字
 */
router.get('/profile', async (req, res) => {
  const u = req.user;
  // 補抓 must_change_password（auth middleware select 沒帶這欄）
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
 * GET /report?range=14d — 用量報告主聚合 endpoint
 * 預設 14 天；可透過 ?range=7d/30d/all 切換
 */
router.get('/report', async (req, res) => {
  try {
    // v1.17.34: 支援 ?start=YYYY-MM-DD&end=YYYY-MM-DD 自訂範圍；否則沿用 ?range=Xd preset
    const range = String(req.query.range || '14d');
    const start = String(req.query.start || '');
    const end = String(req.query.end || '');
    const ISO = /^\d{4}-\d{2}-\d{2}$/;

    // 既輸入 start+end 又通過格式驗證 → 用 BETWEEN，否則用 INTERVAL preset
    // 採直接 string interpolation，但兩者都已 whitelist 驗證過格式（無注入風險）
    let timeFilter;
    if (ISO.test(start) && ISO.test(end)) {
      // end 加 1 天讓當日整天都涵蓋
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

    // ── 個人區塊 ──
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

    // v1.17.34: project 名稱用 LOWER(TRIM(...)) 正規化合併（'ownmind' / 'OwnMind' 算同個）
    // 顯示用 MIN() 取一個原字串（任一變體）
    const myProjectsQ = await query(`
      SELECT LOWER(TRIM(details->>'project')) AS project_key,
        MIN(details->>'project') AS project,
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

    // 鐵律遵守：列出全部 active 鐵律 + 該 user 的遵守統計（LEFT JOIN）
    // v1.17.41: 加 observed（系統自動觀測）獨立欄位，跟 AI manual comply 區隔
    // 誠信：system_auto 不算「已遵守」，只算「系統看到觸發點」
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

    // 個人活動紀錄（時間範圍內全部，前端分頁）
    // v1.17.33: 移除 LIMIT 200，user 反饋「紀錄應該要在時間範圍內都要列出」
    const myActivityQ = await query(`
      SELECT ts, event, tool, source, details
      FROM activity_logs
      WHERE user_id = $1
        AND ts ${timeFilter}
      ORDER BY ts DESC`,
      [me.id]
    );

    // ── 團隊區塊（Q1=C 完全開放）──
    // v1.17.35: 加 tokens / turns 兩個 metric 給前端切換
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

    // v1.17.35: 3 個 trend chart 都加 tokens / turns 數據（活動數仍是預設）
    // 用 FULL OUTER JOIN 把 3 個 dataset 合在一起，避免缺 bucket
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

    // ── 專案區塊（Q2=B 全團隊專案都看得到）──
    // v1.17.30: 改成 per-user 細項顯示「主要負責人」與分工
    // v1.17.34: project 名稱用 LOWER(TRIM(...)) 合併大小寫變體
    // v1.17.36: 多源合併 — session_logs（量化資料）+ handoffs（也算活動跡象，
    //   因為有些工作只寫交接沒寫 session_log，例如 RING 專案）
    const projectContribQ = await query(`
      SELECT LOWER(TRIM(details->>'project')) AS project_key,
        MIN(details->>'project') AS project,
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
    // handoffs 補充（從沒寫 session_log 但有交接的專案）
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
    // 把 handoffs 數加進去；若該 project 之前沒在 session_logs 出現也建立 entry
    for (const r of projectHandoffQ.rows) {
      const h = parseInt(r.handoffs, 10) || 0;
      const key = r.project_key;
      if (!projMap.has(key)) {
        projMap.set(key, { project: r.project, sessions: 0, turns: 0, handoffs: 0, contributors: [] });
      }
      const e = projMap.get(key);
      e.handoffs += h;
      // 找該 user 的 contributor entry，找不到就新增
      let contrib = e.contributors.find(c => c.name === r.name);
      if (!contrib) {
        contrib = { name: r.name, sessions: 0, turns: 0, handoffs: 0 };
        e.contributors.push(contrib);
      }
      contrib.handoffs += h;
    }
    // 排序：先看 turns（主要量化指標），平手看 handoffs，再看 sessions
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

    // ── Server-side 反向稽核（v1.17.38 起）──
    // Codex round 3 review 後（v1.17.39）改進：
    //   P1.1 orphan_session 加 v1.17.37 ship 日期 gate
    //   P1.2 compliance_gap 縮窄 sensitive event 列表 + 用 verification metadata
    //   P2.1 heartbeat 用 LOWER() tool 比對
    const V17_37_SHIPPED = '2026-05-07';  // v1.17.37 之後 emergencySessionLog 才會自動帶 compliance arr

    // #1 activity/compliance gap：v1.17.42 拆兩種等級
    //   gap_a「漏觀測」: 完全沒有任何 compliance event（連系統觀測都沒抓到 → 系統壞了）
    //   gap_b「未驗證」: 有 system_auto observed_trigger 但沒對應鐵律 manual comply
    // v1.17.43: has_manual_comply 加 rule_code 關聯，避免不相關 comply 誤清 gap
    //   每種 sensitive event 對應特定鐵律（expected_rules 陣列）
    const complianceGapQ = await query(`
      WITH sensitive AS (
        SELECT id, ts,
          CASE
            WHEN event = 'memory_disable' THEN ARRAY['IR-006']
            WHEN event = 'memory_save' AND details->>'type' = 'iron_rule' THEN ARRAY['IR-006']
            WHEN event = 'handoff_create' THEN ARRAY['IR-008', 'IR-009', 'IR-024']
          END AS expected_rules
        FROM activity_logs
        WHERE user_id = $1 AND ts ${timeFilter}
          AND (
            event IN ('handoff_create', 'memory_disable')
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
              -- v1.17.45: 排除所有 system_* 自動來源（client + server 兩端）
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

    // #3 heartbeat absence：用 LOWER(TRIM(...)) 比對 tool name 避免大小寫漏判
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

    // #4 cross-source consistency：標記某天 activity 但 0 token_events
    // 排除「某 tool 本來就沒 token scanner」的場景：只看有 collector_heartbeat 的 tool
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

    // #2 orphan session compliance：v1.17.37 之後 ship 才有自動寫 compliance arr
    // 加日期 gate 避免歷史污染
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

    // P3: blind-spot detection — user 有 OwnMind 帳號但完全沒 MCP activity
    // 可能用非 MCP 介面（claude.ai web、ChatGPT）做事，整個不可觀測
    const blindSpotQ = await query(`
      SELECT
        (SELECT COUNT(*) FROM activity_logs WHERE user_id = $1 AND ts >= NOW() - INTERVAL '14 days') AS recent_activity,
        (SELECT COUNT(*) FROM token_events WHERE user_id = $1 AND ts >= NOW() - INTERVAL '14 days') AS recent_tokens,
        (SELECT MAX(last_reported_at) FROM collector_heartbeat WHERE user_id = $1) AS latest_hb,
        EXTRACT(EPOCH FROM (NOW() - $2::timestamptz)) / 86400 AS account_age_days`,
      [me.id, me.created_at]
    );

    // 整理 audit_findings 給前端
    const myAuditFindings = [];
    // v1.17.42: 兩種 gap 嚴重度不同
    //   gap_unobserved（漏觀測）= 連系統都沒抓到 → 系統壞了，high
    //   gap_unverified（未驗證）= 有系統觀測但無 AI 主動回報 → AI 沒承認遵守，medium
    const gapUnobserved = parseInt(complianceGapQ.rows[0]?.gap_unobserved, 10) || 0;
    const gapUnverified = parseInt(complianceGapQ.rows[0]?.gap_unverified, 10) || 0;
    if (gapUnobserved > 0) {
      myAuditFindings.push({
        type: 'compliance_unobserved',
        severity: 'high',
        count: gapUnobserved,
        message: `${gapUnobserved} 個高風險動作（交接 / 停用鐵律 / 新增鐵律）前後 10 分鐘完全沒有任何合規紀錄，連系統自動觀測都沒抓到 → 系統可能有 bug`,
      });
    }
    if (gapUnverified > 0) {
      myAuditFindings.push({
        type: 'compliance_unverified',
        severity: 'medium',
        count: gapUnverified,
        message: `${gapUnverified} 個高風險動作僅由系統自動觀測到，沒有對應鐵律的人工驗證紀錄`,
      });
    }
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
    const orphanCount = parseInt(orphanComplianceQ.rows[0]?.orphan_count, 10) || 0;
    if (orphanCount > 0) {
      myAuditFindings.push({
        type: 'orphan_session',
        severity: 'low',
        count: orphanCount,
        message: `${orphanCount} 個（v1.17.37 起）有實質工作量（≥5 輪）的 session 沒帶 compliance 紀錄，AI 可能整段都沒回報`,
      });
    }

    // P3: blind-spot — 帳號開超過 7 天但完全沒 MCP activity
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

    // #5 IR-027 reverse audit（super_admin only）：
    // user 建立 > 7 天仍預設密碼（must_change_password=TRUE）
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

      // P3 admin 視角：找出「team 內可能用非 MCP 介面工作」的 user
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

    // P2.2: 寫進 audit_logs 表持久化（high severity 才寫，避免噪音）
    // 用既有 audit_logs schema：actor_id=系統(0)、action='audit_finding'、target_type='user'
    // 持久化讓背景監控／email/broadcast 將來可以接（目前先落表，未來再接通知管線）
    for (const f of myAuditFindings) {
      if (f.severity === 'high') {
        // 同 user/type 24h 內已寫過就不重複（粗略 dedup）
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
          // silent fail — 不阻擋報告產出
          logger.warn('audit_finding 持久化失敗', { error: e.message });
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
    logger.error('me/report 失敗', { error: err.message, stack: err.stack });
    res.status(500).json({ error: '報告產生失敗' });
  }
});

export default router;
