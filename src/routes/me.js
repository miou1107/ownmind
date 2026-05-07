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
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = Router();

// 任何 role 都通過，用 auth middleware（一般版，不限 role）
router.use(auth);

/**
 * GET /profile — 驗 api_key，回身份摘要
 * 前端拿來確認 key 有效 + 顯示 user 名字
 */
router.get('/profile', (req, res) => {
  const u = req.user;
  res.json({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    created_at: u.created_at,
  });
});

/**
 * GET /report?range=14d — 用量報告主聚合 endpoint
 * 預設 14 天；可透過 ?range=7d/30d/all 切換
 */
router.get('/report', async (req, res) => {
  try {
    const range = String(req.query.range || '14d');
    const interval = ({
      '7d': "7 days",
      '14d': "14 days",
      '30d': "30 days",
      'all': "100 years",
    })[range] || "14 days";

    const me = req.user;

    // ── 個人區塊 ──
    const myStatsQ = await query(`
      SELECT
        COUNT(*) FILTER (WHERE event = 'init') AS sessions,
        COUNT(*) AS events,
        MAX(ts) AS last_activity
      FROM activity_logs
      WHERE user_id = $1 AND ts >= NOW() - INTERVAL '${interval}'`,
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

    const myProjectsQ = await query(`
      SELECT details->>'project' AS project,
        COUNT(*) AS sessions,
        SUM(COALESCE((details->>'duration_turns')::int, 0)) AS turns,
        ARRAY_AGG(DISTINCT details->>'friction_points') FILTER (WHERE details->>'friction_points' IS NOT NULL) AS friction_points_arr
      FROM session_logs
      WHERE user_id = $1
        AND created_at >= NOW() - INTERVAL '${interval}'
        AND details->>'project' IS NOT NULL
      GROUP BY details->>'project'
      ORDER BY turns DESC NULLS LAST`,
      [me.id]
    );

    const myComplianceQ = await query(`
      SELECT details->>'rule_code' AS rule_code,
        COUNT(*) FILTER (WHERE details->>'action' = 'comply') AS comply,
        COUNT(*) FILTER (WHERE details->>'action' = 'skip') AS skip,
        COUNT(*) FILTER (WHERE details->>'action' = 'violate') AS violate
      FROM activity_logs
      WHERE user_id = $1
        AND event = 'iron_rule_compliance'
        AND ts >= NOW() - INTERVAL '${interval}'
      GROUP BY rule_code
      ORDER BY comply + skip + violate DESC`,
      [me.id]
    );

    // ── 團隊區塊（Q1=C 完全開放）──
    const teamUsersQ = await query(`
      SELECT u.id, u.name, u.email, u.role,
        COUNT(*) FILTER (WHERE al.event = 'init') AS sessions,
        COUNT(al.id) AS events,
        MAX(al.ts) AS last_activity
      FROM users u
      LEFT JOIN activity_logs al ON al.user_id = u.id
        AND al.ts >= NOW() - INTERVAL '${interval}'
      GROUP BY u.id, u.name, u.email, u.role
      ORDER BY events DESC NULLS LAST`
    );

    const dailyTrendQ = await query(`
      SELECT to_char(ts AT TIME ZONE 'Asia/Taipei', 'MM-DD') AS d,
        COUNT(*) AS count
      FROM activity_logs
      WHERE ts >= NOW() - INTERVAL '${interval}'
      GROUP BY d ORDER BY d`
    );

    const hourlyTrendQ = await query(`
      SELECT EXTRACT(HOUR FROM ts AT TIME ZONE 'Asia/Taipei')::int AS hour,
        COUNT(*) AS count
      FROM activity_logs
      WHERE ts >= NOW() - INTERVAL '${interval}'
      GROUP BY hour ORDER BY hour`
    );

    const weekdayTrendQ = await query(`
      SELECT EXTRACT(DOW FROM ts AT TIME ZONE 'Asia/Taipei')::int AS dow,
        COUNT(*) AS count
      FROM activity_logs
      WHERE ts >= NOW() - INTERVAL '${interval}'
      GROUP BY dow ORDER BY dow`
    );

    const eventTypesQ = await query(`
      SELECT event, COUNT(*) AS count
      FROM activity_logs
      WHERE ts >= NOW() - INTERVAL '${interval}'
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
    const teamProjectsQ = await query(`
      SELECT details->>'project' AS project,
        COUNT(*) AS sessions,
        SUM(COALESCE((details->>'duration_turns')::int, 0)) AS turns,
        ARRAY_AGG(DISTINCT u.name) AS owners,
        COUNT(*) FILTER (WHERE sl.user_id = $1) AS my_sessions
      FROM session_logs sl
      JOIN users u ON u.id = sl.user_id
      WHERE sl.created_at >= NOW() - INTERVAL '${interval}'
        AND details->>'project' IS NOT NULL
      GROUP BY details->>'project'
      ORDER BY turns DESC NULLS LAST`,
      [me.id]
    );

    const teamComplianceQ = await query(`
      SELECT details->>'rule_code' AS rule_code,
        COUNT(*) FILTER (WHERE details->>'action' = 'comply') AS comply,
        COUNT(*) FILTER (WHERE details->>'action' = 'skip') AS skip,
        COUNT(*) FILTER (WHERE details->>'action' = 'violate') AS violate,
        COUNT(DISTINCT user_id) AS reporters
      FROM activity_logs
      WHERE event = 'iron_rule_compliance'
        AND ts >= NOW() - INTERVAL '${interval}'
      GROUP BY rule_code
      ORDER BY comply + skip + violate DESC`
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
        compliance: myComplianceQ.rows,
      },
      team: {
        users: teamUsersQ.rows.map(r => ({
          ...r,
          sessions: parseInt(r.sessions, 10) || 0,
          events: parseInt(r.events, 10) || 0,
        })),
        daily_trend: dailyTrendQ.rows.map(r => ({ d: r.d, count: parseInt(r.count, 10) })),
        hourly_trend: hourlyTrendQ.rows.map(r => ({ hour: r.hour, count: parseInt(r.count, 10) })),
        weekday_trend: weekdayTrendQ.rows.map(r => ({ dow: r.dow, count: parseInt(r.count, 10) })),
        event_types: eventTypesQ.rows.map(r => ({ event: r.event, count: parseInt(r.count, 10) })),
        versions: allVersionsQ.rows,
        compliance: teamComplianceQ.rows,
      },
      projects: teamProjectsQ.rows.map(r => ({
        project: r.project,
        sessions: parseInt(r.sessions, 10) || 0,
        turns: parseInt(r.turns, 10) || 0,
        owners: r.owners || [],
        my_sessions: parseInt(r.my_sessions, 10) || 0,
      })),
    });
  } catch (err) {
    logger.error('me/report 失敗', { error: err.message, stack: err.stack });
    res.status(500).json({ error: '報告產生失敗' });
  }
});

export default router;
