import { Router } from 'express';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import adminAuth from '../middleware/adminAuth.js';
import logger from '../utils/logger.js';

const router = Router();

/**
 * POST /batch — 批次上傳 activity log events
 * Body: { events: [{ ts, event, tool, source, details }, ...] }
 * 需要一般 auth（用自己的 API key）
 */
router.post('/batch', auth, async (req, res) => {
  try {
    const { events } = req.body;
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events 必須是非空陣列' });
    }

    // 限制單次上傳量
    const batch = events.slice(0, 500);
    let inserted = 0;

    for (const e of batch) {
      if (!e.ts || !e.event) continue;
      await query(
        `INSERT INTO activity_logs (user_id, ts, event, tool, source, details)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.user.id, e.ts, e.event, e.tool || null, e.source || null, e.details || {}]
      );
      inserted++;
    }

    res.json({ inserted, total: batch.length });
  } catch (err) {
    logger.error('批次上傳 activity log 失敗', { error: err.message });
    res.status(500).json({ error: '上傳失敗' });
  }
});

/**
 * GET /stats?user_id=1&days=30 — 取得單一用戶統計（admin only）
 */
router.get('/stats', adminAuth, async (req, res) => {
  try {
    const userId = Number(req.query.user_id);
    const days = Math.min(Number(req.query.days) || 30, 365);

    if (!userId || isNaN(userId)) return res.status(400).json({ error: '需要有效的 user_id' });

    // 用戶資訊
    const userResult = await query('SELECT id, name, email, role, created_at FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: '用戶不存在' });
    const user = userResult.rows[0];

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    // 記憶統計
    const memoryTotal = await query(
      `SELECT type, status, COUNT(*) as count FROM memories WHERE user_id = $1 GROUP BY type, status`,
      [userId]
    );
    const memoryCreated = await query(
      `SELECT COUNT(*) as count FROM memories WHERE user_id = $1 AND created_at >= $2`,
      [userId, fromDate]
    );

    const byType = {};
    let active = 0, disabled = 0, total = 0;
    for (const row of memoryTotal.rows) {
      byType[row.type] = (byType[row.type] || 0) + parseInt(row.count);
      total += parseInt(row.count);
      if (row.status === 'active') active += parseInt(row.count);
      else disabled += parseInt(row.count);
    }

    // Session 統計
    const sessionStats = await query(
      `SELECT tool, model, compressed, COUNT(*) as count
       FROM session_logs WHERE user_id = $1 GROUP BY tool, model, compressed`,
      [userId]
    );
    const sessionsByTool = {}, sessionsByModel = {};
    let sessionsTotal = 0, sessionsCompressed = 0;
    for (const row of sessionStats.rows) {
      sessionsTotal += parseInt(row.count);
      if (row.compressed) sessionsCompressed += parseInt(row.count);
      sessionsByTool[row.tool] = (sessionsByTool[row.tool] || 0) + parseInt(row.count);
      sessionsByModel[row.model] = (sessionsByModel[row.model] || 0) + parseInt(row.count);
    }

    // Activity 統計
    const activityByEvent = await query(
      `SELECT event, COUNT(*) as count FROM activity_logs
       WHERE user_id = $1 AND ts >= $2 GROUP BY event ORDER BY count DESC LIMIT 20`,
      [userId, fromDate]
    );
    const activityByTool = await query(
      `SELECT tool, COUNT(*) as count FROM activity_logs
       WHERE user_id = $1 AND ts >= $2 GROUP BY tool ORDER BY count DESC LIMIT 20`,
      [userId, fromDate]
    );
    const activityDaily = await query(
      `SELECT TO_CHAR(ts, 'YYYY-MM-DD') as date, COUNT(*) as count
       FROM activity_logs WHERE user_id = $1 AND ts >= $2
       GROUP BY date ORDER BY date`,
      [userId, fromDate]
    );
    const activityTotal = await query(
      `SELECT COUNT(*) as count FROM activity_logs WHERE user_id = $1 AND ts >= $2`,
      [userId, fromDate]
    );

    // 鐵律統計
    const ironRulesResult = await query(
      `SELECT title, tags FROM memories WHERE user_id = $1 AND type = 'iron_rule' AND status = 'active'`,
      [userId]
    );
    const triggerCounts = await query(
      `SELECT details->>'trigger' as trigger_type, COUNT(*) as count
       FROM activity_logs WHERE user_id = $1 AND event = 'iron_rule_trigger' AND ts >= $2
       GROUP BY trigger_type ORDER BY count DESC`,
      [userId, fromDate]
    );
    const totalTriggers = await query(
      `SELECT COUNT(*) as count FROM activity_logs
       WHERE user_id = $1 AND event = 'iron_rule_trigger' AND ts >= $2`,
      [userId, fromDate]
    );

    // 交接統計
    const handoffStats = await query(
      `SELECT status, COUNT(*) as count FROM handoffs WHERE user_id = $1 GROUP BY status`,
      [userId]
    );
    let handoffsTotal = 0, handoffsCompleted = 0, handoffsPending = 0;
    for (const row of handoffStats.rows) {
      handoffsTotal += parseInt(row.count);
      if (row.status === 'accepted') handoffsCompleted += parseInt(row.count);
      if (row.status === 'pending') handoffsPending += parseInt(row.count);
    }

    // 系統健康
    const initSuccess = await query(
      `SELECT COUNT(*) FILTER (WHERE event = 'init') as success,
              COUNT(*) FILTER (WHERE event = 'init_fail') as fail
       FROM activity_logs WHERE user_id = $1 AND ts >= $2`,
      [userId, fromDate]
    );
    const syncConflicts = await query(
      `SELECT COUNT(*) as count FROM activity_logs
       WHERE user_id = $1 AND event = 'sync_conflict' AND ts >= $2`,
      [userId, fromDate]
    );
    const updatesApplied = await query(
      `SELECT COUNT(*) as count FROM activity_logs
       WHERE user_id = $1 AND event = 'update_applied' AND ts >= $2`,
      [userId, fromDate]
    );

    const initS = parseInt(initSuccess.rows[0]?.success || 0);
    const initF = parseInt(initSuccess.rows[0]?.fail || 0);
    const initRate = (initS + initF) > 0 ? ((initS / (initS + initF)) * 100).toFixed(1) : 100;

    // 合規統計（iron_rule_compliance events）
    const complianceResult = await query(
      `SELECT details->>'action' as action, COUNT(*) as count
       FROM activity_logs WHERE user_id = $1 AND event = 'iron_rule_compliance' AND ts >= $2
       GROUP BY action LIMIT 10`,
      [userId, fromDate]
    );
    const complianceByRule = await query(
      `SELECT details->>'rule_title' as rule, details->>'action' as action, COUNT(*) as count
       FROM activity_logs WHERE user_id = $1 AND event = 'iron_rule_compliance' AND ts >= $2
       GROUP BY rule, action ORDER BY count DESC LIMIT 30`,
      [userId, fromDate]
    );
    // 按工具 × 合規
    const complianceByTool = await query(
      `SELECT tool, details->>'action' as action, COUNT(*) as count
       FROM activity_logs WHERE user_id = $1 AND event = 'iron_rule_compliance' AND ts >= $2
       GROUP BY tool, action ORDER BY tool, count DESC LIMIT 30`,
      [userId, fromDate]
    );

    // 計算合規率
    const compActions = {};
    for (const r of complianceResult.rows) compActions[r.action] = parseInt(r.count);
    const totalComp = (compActions.comply || 0) + (compActions.skip || 0) + (compActions.violate || 0);
    const complianceRate = totalComp > 0 ? (((compActions.comply || 0) / totalComp) * 100).toFixed(1) : null;

    // 按規則彙整合規
    const ruleCompliance = {};
    for (const r of complianceByRule.rows) {
      if (!ruleCompliance[r.rule]) ruleCompliance[r.rule] = { comply: 0, skip: 0, violate: 0 };
      ruleCompliance[r.rule][r.action] = parseInt(r.count);
    }

    // 按工具彙整合規
    const toolCompliance = {};
    for (const r of complianceByTool.rows) {
      if (!toolCompliance[r.tool]) toolCompliance[r.tool] = { comply: 0, skip: 0, violate: 0 };
      toolCompliance[r.tool][r.action] = parseInt(r.count);
    }

    res.json({
      user,
      period: { days, from: fromDate.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
      memory: {
        total, by_type: byType, active, disabled,
        created_this_period: parseInt(memoryCreated.rows[0]?.count || 0)
      },
      sessions: {
        total: sessionsTotal, by_tool: sessionsByTool, by_model: sessionsByModel,
        compressed: sessionsCompressed
      },
      activity: {
        total_events: parseInt(activityTotal.rows[0]?.count || 0),
        by_event: Object.fromEntries(activityByEvent.rows.map(r => [r.event, parseInt(r.count)])),
        by_tool: Object.fromEntries(activityByTool.rows.map(r => [r.tool, parseInt(r.count)])),
        daily: activityDaily.rows.map(r => ({ date: r.date, count: parseInt(r.count) }))
      },
      iron_rules: {
        total_active: ironRulesResult.rows.length,
        total_triggers: parseInt(totalTriggers.rows[0]?.count || 0),
        top_triggered: triggerCounts.rows.map(r => ({ trigger: r.trigger_type, count: parseInt(r.count) }))
      },
      compliance: {
        total: totalComp,
        rate: complianceRate ? parseFloat(complianceRate) : null,
        by_action: compActions,
        by_rule: ruleCompliance,
        by_tool: toolCompliance
      },
      handoffs: { total: handoffsTotal, completed: handoffsCompleted, pending: handoffsPending },
      health: {
        init_success_rate: parseFloat(initRate),
        sync_conflicts: parseInt(syncConflicts.rows[0]?.count || 0),
        updates_applied: parseInt(updatesApplied.rows[0]?.count || 0)
      }
    });
  } catch (err) {
    logger.error('取得統計失敗', { error: err.message });
    res.status(500).json({ error: '取得統計失敗' });
  }
});

/**
 * GET /stats/all — 跨用戶總覽（admin only）
 */
router.get('/stats/all', adminAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    const result = await query(`
      SELECT u.id, u.name, u.email, u.created_at,
        (SELECT COUNT(*) FROM memories WHERE user_id = u.id AND status = 'active') as memory_count,
        (SELECT COUNT(*) FROM session_logs WHERE user_id = u.id) as session_count,
        (SELECT COUNT(*) FROM activity_logs WHERE user_id = u.id AND ts >= $1) as activity_count,
        (SELECT COUNT(*) FROM activity_logs WHERE user_id = u.id AND event = 'iron_rule_compliance' AND details->>'action' = 'comply' AND ts >= $1) as comply_count,
        (SELECT COUNT(*) FROM activity_logs WHERE user_id = u.id AND event = 'iron_rule_compliance' AND ts >= $1) as compliance_total,
        (SELECT MAX(ts) FROM activity_logs WHERE user_id = u.id) as last_active
      FROM users u ORDER BY last_active DESC NULLS LAST
    `, [fromDate]);

    const users = result.rows.map(u => ({
      ...u,
      compliance_rate: parseInt(u.compliance_total) > 0
        ? ((parseInt(u.comply_count) / parseInt(u.compliance_total)) * 100).toFixed(1)
        : null
    }));

    res.json({ period: { days }, users });
  } catch (err) {
    logger.error('取得跨用戶統計失敗', { error: err.message });
    res.status(500).json({ error: '取得統計失敗' });
  }
});

export default router;
