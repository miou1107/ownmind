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
    const myComplianceQ = await query(`
      WITH stats AS (
        SELECT details->>'rule_code' AS rule_code,
          COUNT(*) FILTER (WHERE details->>'action' = 'comply') AS comply,
          COUNT(*) FILTER (WHERE details->>'action' = 'skip') AS skip,
          COUNT(*) FILTER (WHERE details->>'action' = 'violate') AS violate
        FROM activity_logs
        WHERE user_id = $1
          AND event = 'iron_rule_compliance'
          AND ts ${timeFilter}
        GROUP BY rule_code
      )
      SELECT m.code AS rule_code, m.title,
        COALESCE(s.comply, 0) AS comply,
        COALESCE(s.skip, 0) AS skip,
        COALESCE(s.violate, 0) AS violate
      FROM memories m
      LEFT JOIN stats s ON s.rule_code = m.code
      WHERE m.type = 'iron_rule' AND m.status = 'active' AND m.code IS NOT NULL
      ORDER BY (COALESCE(s.comply,0) + COALESCE(s.skip,0) + COALESCE(s.violate,0)) DESC,
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
        projMap.set(key, { project: r.project, sessions: 0, turns: 0, handoffs: 0, contributors: [], my_sessions: 0, my_handoffs: 0 });
      }
      const e = projMap.get(key);
      e.sessions += s;
      e.turns += t;
      e.contributors.push({ name: r.name, sessions: s, turns: t, handoffs: 0 });
      if (r.name === me.name) e.my_sessions += s;
    }
    // 把 handoffs 數加進去；若該 project 之前沒在 session_logs 出現也建立 entry
    for (const r of projectHandoffQ.rows) {
      const h = parseInt(r.handoffs, 10) || 0;
      const key = r.project_key;
      if (!projMap.has(key)) {
        projMap.set(key, { project: r.project, sessions: 0, turns: 0, handoffs: 0, contributors: [], my_sessions: 0, my_handoffs: 0 });
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
      if (r.name === me.name) e.my_handoffs += h;
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
        })),
        activity: myActivityQ.rows,
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
