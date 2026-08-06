import { Router } from 'express';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import adminAuth from '../middleware/adminAuth.js';
import logger from '../utils/logger.js';
import { enrichActivityDetails } from '../utils/enrich-activity.js';
import { bucketLabel } from '../utils/session-buckets.js';
import { insertActivityLog, normalizeClientEventId } from '../utils/activity-insert.js';
import { RULE_FULL_LAYER_SYNC, getEventDisplayName } from '../../shared/lint-event-types.js';

// v1.17.89: enrich lookup — injected DB query for enrichActivityDetails.
// Wrapped as a module-level function so the batch handler can reuse it for
// every event.
//
// ⚠️ DO NOT add a status='active' filter!
//   memory_disable events hit the DB after the row in `memories` has
//   already become status='disabled'. Adding an active filter would mean
//   newly-disabled iron rules never enrich → we'd recreate the "(not found)"
//   problem. The v1.17.89 code reviewer confirmed this and explicitly
//   asked for the filter to stay off.
//
// ⚠️ Performance: today the batch handler runs N SELECTs (serially) for N
// disable/update events. In practice a batch usually carries 1–3 events,
// so the impact is negligible. If batches grow much larger (>50 events) we
// can switch to a single IN (...) query (v1.17.90 backlog).
async function memoryLookup(id) {
  const r = await query(
    `SELECT type, code, title FROM memories WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

const router = Router();

/**
 * Analyze a context report from session_logs.details.
 */
async function getContextAnalysis(userId, fromDate) {
  try {
    const sessions = await query(
      `SELECT tool, model, details FROM session_logs
       WHERE user_id = $1 AND created_at >= $2 AND details IS NOT NULL AND details != '{}'::jsonb
       ORDER BY created_at DESC LIMIT 100`,
      [userId, fromDate]
    );

    if (sessions.rows.length === 0) return null;

    const actionCounts = {};
    const projectCounts = {};
    const frictionPoints = [];
    const suggestions = [];
    let totalTurns = 0;
    let sessionsWithTurns = 0;

    for (const s of sessions.rows) {
      const d = s.details;
      // Actions
      if (Array.isArray(d.actions)) {
        for (const a of d.actions) actionCounts[a] = (actionCounts[a] || 0) + 1;
      }
      // Projects
      if (d.project) projectCounts[d.project] = (projectCounts[d.project] || 0) + 1;
      // Turns
      if (d.duration_turns) { totalTurns += d.duration_turns; sessionsWithTurns++; }
      // Friction & suggestions
      if (d.friction_points) frictionPoints.push({ tool: s.tool, text: d.friction_points });
      if (d.suggestions) suggestions.push({ tool: s.tool, text: d.suggestions });
    }

    return {
      sessions_with_context: sessions.rows.length,
      avg_turns: sessionsWithTurns > 0 ? Math.round(totalTurns / sessionsWithTurns) : null,
      top_actions: Object.entries(actionCounts).sort((a, b) => b[1] - a[1]).slice(0, 10),
      top_projects: Object.entries(projectCounts).sort((a, b) => b[1] - a[1]).slice(0, 10),
      friction_points: frictionPoints.slice(0, 10),
      suggestions: suggestions.slice(0, 10),
    };
  } catch {
    return null;
  }
}

/**
 * POST /batch — upload activity log events in batch.
 * Body: { events: [{ ts, event, tool, source, details }, ...] }
 * Requires regular auth (the user's own API key).
 */
// v1.17.45: server-side auto observability (the final form of the
// logic-over-reminders principle).
// The earlier client-side autoComplyForToolCall in mcp/index.js required
// every user to upgrade to v1.17.40+; in practice some users get stuck on
// old versions (e.g. Bob on 1.17.16). Move the logic to the server: when
// activity arrives, if the event is high-risk, automatically emit an
// observed_trigger compliance event — independent of client version.
// v1.26.32: de-identified. The compliance loop keys on the neutral event
// constant RULE_FULL_LAYER_SYNC instead of one user's personal rule code.
// rule_code is left empty on the server side — cache-holding callers resolve
// the user's own code (see buildComplianceEvents).
export async function autoEmitObservedTrigger(userId, event) {
  const ruleTitle = getEventDisplayName(RULE_FULL_LAYER_SYNC);
  // memory_save with type=iron_rule → full-layer-sync trigger.
  if (event.event === 'memory_save' && event.details?.type === 'iron_rule') {
    return {
      triggered_by_event: RULE_FULL_LAYER_SYNC,
      rule_code: '',
      rule_title: ruleTitle,
      tool_call: 'memory_save',
      context: `Added iron rule "${event.details.title || ''}"`,
    };
  }
  // memory_disable: need to look up memories.type to know if it's an iron_rule.
  if (event.event === 'memory_disable' && event.details?.id) {
    const r = await query(
      `SELECT type, code, title FROM memories WHERE id = $1`,
      [event.details.id]
    );
    if (r.rows[0]?.type === 'iron_rule') {
      return {
        triggered_by_event: RULE_FULL_LAYER_SYNC,
        rule_code: '',
        rule_title: ruleTitle,
        tool_call: 'memory_disable',
        context: `Disabled iron rule ${r.rows[0].code || ''}: ${r.rows[0].title || ''}`,
      };
    }
  }
  // memory_update with iron_rule type.
  if (event.event === 'memory_update' && event.details?.id) {
    const r = await query(
      `SELECT type, code FROM memories WHERE id = $1`,
      [event.details.id]
    );
    if (r.rows[0]?.type === 'iron_rule') {
      return {
        triggered_by_event: RULE_FULL_LAYER_SYNC,
        rule_code: '',
        rule_title: ruleTitle,
        tool_call: 'memory_update',
        context: `Updated iron rule ${r.rows[0].code || ''}`,
      };
    }
  }
  // Do not auto-observe handoff_create (Codex round-4 review concerned about
  // over-extrapolation; the concern still applies).
  return null;
}

router.post('/batch', auth, async (req, res) => {
  try {
    const { events } = req.body;
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events must be a non-empty array' });
    }

    // Cap the batch size.
    const batch = events.slice(0, 500);
    let inserted = 0;
    let deduped = 0;
    let autoObserved = 0;

    for (const e of batch) {
      if (!e.ts || !e.event) continue;

      // v1.17.99: dedup INSERT logic moved to src/utils/activity-insert.js
      // so the handler and tests/activity-batch-dedup.test.js share the same
      // implementation (addressing v1.17.98 review I1).
      // normalizeClientEventId handles: non-string / non-UUID v4 → null.
      const clientEventId = normalizeClientEventId(e.client_event_id);

      // v1.17.89: enrich details before insert — fill in code+title snapshot
      // for disable/update iron_rule events so future pitfalls queries can
      // show full context without JOINing memories. Enrich failure swallows
      // its own errors (pure function with built-in try/catch) and returns
      // the original details.
      const enrichedDetails = await enrichActivityDetails(e, memoryLookup);

      // Use the v1.17.99 shared helper — internally it splits into two paths
      // (pure INSERT for NULL client id; ON CONFLICT path for present id).
      const { inserted: didInsert } = await insertActivityLog(query, {
        userId: req.user.id,
        ts: e.ts,
        event: e.event,
        tool: e.tool || null,
        source: e.source || null,
        details: enrichedDetails,
        clientEventId,
      });
      if (!didInsert) {
        deduped++;
        continue;  // Don't run the auto-observe trigger — avoid generating
                   // duplicate derived events when the same event is replayed.
      }
      inserted++;

      // v1.17.45 server-side auto observability: high-risk events also get
      // an observed_trigger row. The source can be either the client's
      // system_auto or "client didn't upgrade"; the server writes it either way.
      try {
        const trigger = await autoEmitObservedTrigger(req.user.id, e);
        if (trigger) {
          await query(
            `INSERT INTO activity_logs (user_id, ts, event, tool, source, details)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              req.user.id,
              e.ts,  // Reuse the same ts so the ±10 minute window still matches.
              'iron_rule_compliance',
              e.tool || 'server',
              'system_server_auto',
              JSON.stringify({
                rule_code: trigger.rule_code,
                rule_title: trigger.rule_title,
                triggered_by_event: trigger.triggered_by_event,
                action: 'observed_trigger',
                source: 'system_server_auto',
                tool_call: trigger.tool_call,
                context: trigger.context,
              }),
            ]
          );
          autoObserved++;
        }
      } catch (err) {
        logger.warn('server-side auto observability failed (main flow not blocked)', {
          error: err.message,
          event: e.event,
        });
      }
    }

    res.json({ inserted, deduped, total: batch.length, auto_observed: autoObserved });
  } catch (err) {
    logger.error('activity log batch upload failed', { error: err.message });
    res.status(500).json({ error: 'Upload failed' });
  }
});

/**
 * GET /stats?user_id=1&days=30 — single-user statistics (admin only).
 */
router.get('/stats', adminAuth, async (req, res) => {
  try {
    const userId = Number(req.query.user_id);
    const days = Math.min(Number(req.query.days) || 30, 365);

    if (!userId || isNaN(userId)) return res.status(400).json({ error: 'a valid user_id is required' });

    // User info.
    const userResult = await query('SELECT id, name, email, role, created_at FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'user not found' });
    const user = userResult.rows[0];

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    // Memory statistics.
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

    // Session statistics.
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
      // v1.26.61: bucketLabel, not the raw column. `model` became optional when
      // requiring it started discarding whole session records, and `byModel[null]`
      // produces a chart category literally named "null" — an absence rendered as a
      // value, which is the defect Requirement 7 exists to prevent.
      const toolKey = bucketLabel(row.tool);
      const modelKey = bucketLabel(row.model);
      sessionsByTool[toolKey] = (sessionsByTool[toolKey] || 0) + parseInt(row.count);
      sessionsByModel[modelKey] = (sessionsByModel[modelKey] || 0) + parseInt(row.count);
    }

    // Recovery session statistics.
    const recoveredSessions = await query(
      `SELECT COUNT(*) as count FROM session_logs
       WHERE user_id = $1 AND (details->>'_recovery') IS NOT NULL`,
      [userId]
    );
    const sessionsRecovered = parseInt(recoveredSessions.rows[0]?.count || 0);

    // Activity statistics.
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

    // Iron-rule statistics.
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

    // Handoff statistics.
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

    // System health.
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

    // Compliance statistics (iron_rule_compliance events).
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
    // By tool × compliance.
    const complianceByTool = await query(
      `SELECT tool, details->>'action' as action, COUNT(*) as count
       FROM activity_logs WHERE user_id = $1 AND event = 'iron_rule_compliance' AND ts >= $2
       GROUP BY tool, action ORDER BY tool, count DESC LIMIT 30`,
      [userId, fromDate]
    );

    // Compliance rate.
    const compActions = {};
    for (const r of complianceResult.rows) compActions[r.action] = parseInt(r.count);
    const totalComp = (compActions.comply || 0) + (compActions.skip || 0) + (compActions.violate || 0);
    const complianceRate = totalComp > 0 ? (((compActions.comply || 0) / totalComp) * 100).toFixed(1) : null;

    // Aggregate compliance by rule.
    const ruleCompliance = {};
    for (const r of complianceByRule.rows) {
      if (!ruleCompliance[r.rule]) ruleCompliance[r.rule] = { comply: 0, skip: 0, violate: 0 };
      ruleCompliance[r.rule][r.action] = parseInt(r.count);
    }

    // Aggregate compliance by tool.
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
        compressed: sessionsCompressed, recovered: sessionsRecovered
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
      },
      context: await getContextAnalysis(userId, fromDate)
    });
  } catch (err) {
    logger.error('activity stats failed', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

/**
 * GET /stats/rules?user_id=1&days=30 — per-iron-rule enforced/skipped/violated stats (admin only).
 */
router.get('/stats/rules', adminAuth, async (req, res) => {
  try {
    const userId = Number(req.query.user_id);
    const days = Math.min(Number(req.query.days) || 30, 365);
    if (!userId || isNaN(userId)) return res.status(400).json({ error: 'a valid user_id is required' });

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    // Fetch active iron rules.
    const rules = await query(
      `SELECT id, code, title, tags, metadata FROM memories
       WHERE user_id = $1 AND type = 'iron_rule' AND status = 'active'
       ORDER BY code, created_at`,
      [userId]
    );

    // Fetch every compliance event.
    const events = await query(
      `SELECT details->>'rule_title' as rule_title,
              details->>'rule_code' as rule_code,
              details->>'action' as action,
              tool,
              COUNT(*) as count
       FROM activity_logs
       WHERE user_id = $1 AND event = 'iron_rule_compliance' AND ts >= $2
       GROUP BY rule_title, rule_code, action, tool
       ORDER BY count DESC LIMIT 200`,
      [userId, fromDate]
    );

    // Fetch trigger events (hook-layer triggers).
    const triggers = await query(
      `SELECT details->>'trigger' as trigger_type, COUNT(*) as count
       FROM activity_logs
       WHERE user_id = $1 AND event = 'iron_rule_trigger' AND ts >= $2
       GROUP BY trigger_type ORDER BY count DESC`,
      [userId, fromDate]
    );

    // Aggregate by rule.
    const ruleStats = {};
    for (const r of rules.rows) {
      const key = r.code || r.title;
      ruleStats[key] = {
        id: r.id, code: r.code, title: r.title, tags: r.tags,
        enforced: 0, skipped: 0, violated: 0, triggered: 0,
        by_tool: {}
      };
    }

    for (const e of events.rows) {
      const key = e.rule_code || e.rule_title;
      if (!ruleStats[key]) {
        ruleStats[key] = { code: e.rule_code, title: e.rule_title, enforced: 0, skipped: 0, violated: 0, triggered: 0, by_tool: {} };
      }
      const count = parseInt(e.count);
      if (e.action === 'comply') ruleStats[key].enforced += count;
      else if (e.action === 'skip') ruleStats[key].skipped += count;
      else if (e.action === 'violate') ruleStats[key].violated += count;

      // By tool.
      if (!ruleStats[key].by_tool[e.tool]) ruleStats[key].by_tool[e.tool] = { enforced: 0, skipped: 0, violated: 0 };
      if (e.action === 'comply') ruleStats[key].by_tool[e.tool].enforced += count;
      else if (e.action === 'skip') ruleStats[key].by_tool[e.tool].skipped += count;
      else if (e.action === 'violate') ruleStats[key].by_tool[e.tool].violated += count;
    }

    // Compliance rate.
    const result = Object.values(ruleStats).map(r => {
      const total = r.enforced + r.skipped + r.violated;
      return {
        ...r,
        total,
        compliance_rate: total > 0 ? parseFloat(((r.enforced / total) * 100).toFixed(1)) : null
      };
    }).sort((a, b) => (b.total || 0) - (a.total || 0));

    const triggersByType = Object.fromEntries(triggers.rows.map(r => [r.trigger_type, parseInt(r.count)]));

    res.json({
      period: { days },
      rules: result,
      triggers: triggersByType,
      summary: {
        total_rules: rules.rows.length,
        rules_with_data: result.filter(r => r.total > 0).length,
        rules_never_tested: result.filter(r => r.total === 0).map(r => r.title),
      }
    });
  } catch (err) {
    logger.error('iron rule stats failed', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

/**
 * GET /stats/all — cross-user overview (admin only).
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
        -- v1.26.74 — the same correction as team-overview.js, for the same reason. This
        -- was MAX(activity_logs.ts) alone, which only moves when the AI calls an ownmind
        -- tool; a long coding session may never call one, so somebody working right now
        -- read as last active hours ago. Two pages answering the same question with
        -- different numbers is its own defect, so both use the newest of the three
        -- sources. GREATEST ignores NULLs and is NULL only when every source is.
        GREATEST(
          (SELECT MAX(ts) FROM activity_logs WHERE user_id = u.id),
          (SELECT MAX(ts) FROM token_events WHERE user_id = u.id),
          (SELECT MAX(created_at) FROM session_logs WHERE user_id = u.id)
        ) as last_active
      FROM users u ORDER BY last_active DESC NULLS LAST
    `, [fromDate]);

    // Per-user tool/model distribution.
    const toolModelResult = await query(
      `SELECT user_id, tool, model, COUNT(*) as count
       FROM session_logs WHERE created_at >= $1
       GROUP BY user_id, tool, model ORDER BY count DESC`,
      [fromDate]
    );
    // Per-user AI compliance (by tool).
    const toolCompResult = await query(
      `SELECT user_id, tool, details->>'action' as action, COUNT(*) as count
       FROM activity_logs WHERE event = 'iron_rule_compliance' AND ts >= $1
       GROUP BY user_id, tool, action`,
      [fromDate]
    );

    // Aggregate.
    const userToolModels = {};
    for (const r of toolModelResult.rows) {
      if (!userToolModels[r.user_id]) userToolModels[r.user_id] = { tools: {}, models: {} };
      // Same reason as the per-user grouping above.
      const tKey = bucketLabel(r.tool);
      const mKey = bucketLabel(r.model);
      userToolModels[r.user_id].tools[tKey] = (userToolModels[r.user_id].tools[tKey] || 0) + parseInt(r.count);
      userToolModels[r.user_id].models[mKey] = (userToolModels[r.user_id].models[mKey] || 0) + parseInt(r.count);
    }

    const userToolComp = {};
    for (const r of toolCompResult.rows) {
      if (!userToolComp[r.user_id]) userToolComp[r.user_id] = {};
      if (!userToolComp[r.user_id][r.tool]) userToolComp[r.user_id][r.tool] = { comply: 0, skip: 0, violate: 0 };
      userToolComp[r.user_id][r.tool][r.action] = parseInt(r.count);
    }

    const users = result.rows.map(u => {
      const tm = userToolModels[u.id] || { tools: {}, models: {} };
      const tc = userToolComp[u.id] || {};
      // Per-tool compliance rate.
      const toolStats = Object.entries(tc).map(([tool, acts]) => {
        const total = (acts.comply||0) + (acts.skip||0) + (acts.violate||0);
        return { tool, ...acts, total, rate: total > 0 ? parseFloat(((acts.comply||0)/total*100).toFixed(1)) : null };
      });

      return {
        ...u,
        compliance_rate: parseInt(u.compliance_total) > 0
          ? ((parseInt(u.comply_count) / parseInt(u.compliance_total)) * 100).toFixed(1)
          : null,
        tools: tm.tools,
        models: tm.models,
        tool_compliance: toolStats
      };
    });

    res.json({ period: { days }, users });
  } catch (err) {
    logger.error('cross-user stats failed', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

export default router;
