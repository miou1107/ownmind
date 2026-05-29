// src/jobs/weeklyReport.js
import cron from 'node-cron';
import { query } from '../utils/db.js';
import { computePeriodRange, groupFrictions } from '../utils/report.js';
import logger from '../utils/logger.js';

const FRICTION_THRESHOLD = 3; // only create an issue at >= 3 occurrences

/**
 * Create a project memory for high-frequency friction (deduplicated)
 */
async function createFrictionIssues(userId, topFrictions, periodLabel) {
  let created = 0;
  for (const f of topFrictions) {
    if (f.count < FRICTION_THRESHOLD) continue;

    const key = f.text.toLowerCase().trim().slice(0, 20);
    // escape LIKE special chars so % and _ don't interfere with matching
    const escapedKey = key.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const titlePrefix = `⚠️ 高頻 friction：`;
    const titleSnippet = f.text.slice(0, 50);

    // check whether it already exists (avoid duplicates)
    const existing = await query(
      `SELECT id FROM memories
       WHERE user_id = $1
         AND tags @> ARRAY['friction-issue']
         AND LOWER(title) LIKE $2 ESCAPE '\\'
         AND status = 'active'
       LIMIT 1`,
      [userId, `%${escapedKey}%`]
    );

    if (existing.rows.length > 0) continue;

    await query(
      `INSERT INTO memories (user_id, type, title, content, tags, status)
       VALUES ($1, 'project', $2, $3, $4, 'active')`,
      [
        userId,
        `${titlePrefix}${titleSnippet}`,
        `${periodLabel} 期間出現 ${f.count} 次。`,
        ['friction-issue', 'auto-generated'],
      ]
    );
    created++;
  }
  return created;
}

/**
 * Create a principle memory for high-frequency suggestions (deduplicated)
 */
async function createSuggestionActions(userId, topSuggestions, periodLabel) {
  let created = 0;
  for (const s of topSuggestions) {
    if (s.count < FRICTION_THRESHOLD) continue;

    const key = s.text.toLowerCase().trim().slice(0, 20);
    const escapedKey = key.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const titlePrefix = `💡 高頻建議：`;
    const titleSnippet = s.text.slice(0, 50);

    // check whether it already exists (avoid duplicates)
    const existing = await query(
      `SELECT id FROM memories
       WHERE user_id = $1
         AND tags @> ARRAY['suggestion-action']
         AND LOWER(title) LIKE $2 ESCAPE '\\'
         AND status = 'active'
       LIMIT 1`,
      [userId, `%${escapedKey}%`]
    );

    if (existing.rows.length > 0) continue;

    await query(
      `INSERT INTO memories (user_id, type, title, content, tags, status)
       VALUES ($1, 'principle', $2, $3, $4, 'active')`,
      [
        userId,
        `${titlePrefix}${titleSnippet}`,
        `${periodLabel} 期間被 AI 建議 ${s.count} 次。`,
        ['suggestion-action', 'auto-generated'],
      ]
    );
    created++;
  }
  return created;
}

/**
 * Run the weekly report job (pass a userId for single-user processing; defaults to all)
 */
export async function runWeeklyReport(targetUserId = null) {
  logger.info('Weekly report job started');
  const { start, end, label } = computePeriodRange('week', 1); // last week

  try {
    // get all active users (or the specified user)
    const usersResult = await query(
      targetUserId
        ? `SELECT id FROM users WHERE id = $1`
        : `SELECT id FROM users WHERE role IN ('admin', 'user')`,
      targetUserId ? [targetUserId] : []
    );

    for (const user of usersResult.rows) {
      const userId = user.id;

      // get last week's session logs
      const sessions = await query(
        `SELECT details FROM session_logs
         WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3
           AND details IS NOT NULL AND details != '{}'::jsonb
           AND compressed = false`,
        [userId, start, end]
      );

      // collect friction / suggestions
      const frictions = sessions.rows
        .map(r => r.details?.friction_points)
        .filter(Boolean);
      const suggestions = sessions.rows
        .map(r => r.details?.suggestions)
        .filter(Boolean);

      const topFrictions = groupFrictions(frictions).slice(0, 10);
      const topSuggestions = groupFrictions(suggestions).slice(0, 10);

      // create high-frequency friction issues + suggestion actions
      const frictionIssuesCreated = await createFrictionIssues(userId, topFrictions, label);
      const suggestionActionsCreated = await createSuggestionActions(userId, topSuggestions, label);

      // Compliance stats
      const complianceResult = await query(
        `SELECT details->>'rule_title' as rule_title,
                details->>'action' as action,
                COUNT(*) as count
         FROM activity_logs
         WHERE user_id = $1 AND event = 'iron_rule_compliance'
           AND ts >= $2 AND ts <= $3
         GROUP BY rule_title, action`,
        [userId, start, end]
      );
      const complianceByRule = {};
      for (const row of complianceResult.rows) {
        const key = row.rule_title;
        if (!complianceByRule[key]) complianceByRule[key] = { comply: 0, violate: 0, skip: 0 };
        complianceByRule[key][row.action] = parseInt(row.count, 10);
      }
      const totalComply = Object.values(complianceByRule).reduce((s, r) => s + r.comply, 0);
      const totalViolate = Object.values(complianceByRule).reduce((s, r) => s + r.violate, 0);
      const totalAll = totalComply + totalViolate + Object.values(complianceByRule).reduce((s, r) => s + r.skip, 0);
      const complianceRate = totalAll > 0 ? Math.round((totalComply / totalAll) * 100) : null;
      const topViolated = Object.entries(complianceByRule)
        .filter(([, v]) => v.violate > 0)
        .sort((a, b) => b[1].violate - a[1].violate)
        .slice(0, 3)
        .map(([title, v]) => ({ title, violate: v.violate, comply: v.comply }));

      // count newly added memories
      const memoriesResult = await query(
        `SELECT COUNT(*) as cnt FROM memories
         WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3
           AND status = 'active' AND NOT (tags @> ARRAY['pending_review'])`,
        [userId, start, end]
      );
      const newMemories = parseInt(memoriesResult.rows[0].cnt, 10);

      // build the weekly report snapshot (stored in session_logs)
      // convert to Taipei time before computing the week number (start is UTC Sunday 16:00 = Taipei Monday 00:00)
      const taipeiStart = new Date(start.getTime() + 8 * 3600000);
      const weekNum = getWeekNumber(taipeiStart);
      const year = taipeiStart.getUTCFullYear();
      const title = `週報 ${year}-W${String(weekNum).padStart(2, '0')}`;

      // dedup: don't recreate a weekly report with the same title
      const existingReport = await query(
        `SELECT id FROM session_logs WHERE user_id = $1 AND summary = $2 LIMIT 1`,
        [userId, title]
      );

      if (existingReport.rows.length === 0) {
        await query(
          `INSERT INTO session_logs (user_id, tool, model, summary, details, compressed)
           VALUES ($1, 'system', 'weekly-job', $2, $3, false)`,
          [
            userId,
            title,
            JSON.stringify({
              period: label,
              new_memories: newMemories,
              friction_issues_created: frictionIssuesCreated,
              suggestion_actions_created: suggestionActionsCreated,
              top_frictions: topFrictions.slice(0, 5),
              top_suggestions: topSuggestions.slice(0, 5),
              compliance_summary: {
                compliance_rate: complianceRate,
                total_events: totalAll,
                top_violated: topViolated,
              },
            }),
          ]
        );
        logger.info(`Weekly report created: ${title}`, { userId, frictionIssuesCreated, suggestionActionsCreated, newMemories });
      }
    }
  } catch (err) {
    logger.error('Weekly report job failed', { error: err.message });
  }
}

/**
 * Monthly report job: aggregate all weekly report snapshots for the month
 */
export async function runMonthlyReport(targetUserId = null) {
  logger.info('Monthly report job started');
  const { start, end, label } = computePeriodRange('month', 1); // last month

  const year = new Date(start.getTime() + 8 * 3600000).getUTCFullYear();
  const month = new Date(start.getTime() + 8 * 3600000).getUTCMonth() + 1;
  const title = `月報 ${year}-${String(month).padStart(2, '0')}`;

  try {
    const usersResult = await query(
      targetUserId
        ? `SELECT id FROM users WHERE id = $1`
        : `SELECT id FROM users WHERE role IN ('admin', 'user')`,
      targetUserId ? [targetUserId] : []
    );

    for (const user of usersResult.rows) {
      const userId = user.id;

      // dedup
      const existing = await query(
        `SELECT id FROM session_logs WHERE user_id = $1 AND summary = $2 LIMIT 1`,
        [userId, title]
      );
      if (existing.rows.length > 0) continue;

      // aggregate this month's weekly reports
      const weeklyReports = await query(
        `SELECT details FROM session_logs
         WHERE user_id = $1 AND tool = 'system' AND model = 'weekly-job'
           AND created_at >= $2 AND created_at <= $3`,
        [userId, start, end]
      );

      let newMemories = 0;
      let frictionIssuesCreated = 0;
      let suggestionActionsCreated = 0;
      const allFrictions = [];
      const allSuggestions = [];

      for (const r of weeklyReports.rows) {
        const d = r.details;
        if (!d) continue;
        newMemories += d.new_memories || 0;
        frictionIssuesCreated += d.friction_issues_created || 0;
        suggestionActionsCreated += d.suggestion_actions_created || 0;
        // preserve count: repeat text count times then group, to sum correctly
        if (Array.isArray(d.top_frictions)) {
          for (const f of d.top_frictions) {
            for (let i = 0; i < (f.count || 1); i++) allFrictions.push(f.text);
          }
        }
        if (Array.isArray(d.top_suggestions)) {
          for (const s of d.top_suggestions) {
            for (let i = 0; i < (s.count || 1); i++) allSuggestions.push(s.text);
          }
        }
      }

      await query(
        `INSERT INTO session_logs (user_id, tool, model, summary, details, compressed)
         VALUES ($1, 'system', 'monthly-job', $2, $3, false)`,
        [
          userId,
          title,
          JSON.stringify({
            period: label,
            new_memories: newMemories,
            friction_issues_created: frictionIssuesCreated,
            suggestion_actions_created: suggestionActionsCreated,
            top_frictions: groupFrictions(allFrictions).slice(0, 5),
            top_suggestions: groupFrictions(allSuggestions).slice(0, 5),
          }),
        ]
      );
      logger.info(`Monthly report created: ${title}`, { userId });
    }
  } catch (err) {
    logger.error('Monthly report job failed', { error: err.message });
  }
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * Start the scheduled jobs (all using the Asia/Taipei timezone)
 * Weekly report: every Monday 00:00
 * Monthly report: the 1st of each month 00:00
 */
export function startJobs() {
  // weekly report: every Monday 00:00 Asia/Taipei
  cron.schedule('0 0 * * 1', () => {
    runWeeklyReport().catch(err => logger.error('Weekly report cron failed', { error: err.message }));
  }, { timezone: 'Asia/Taipei' });

  // monthly report: the 1st of each month 00:00 Asia/Taipei
  cron.schedule('0 0 1 * *', () => {
    runMonthlyReport().catch(err => logger.error('Monthly report cron failed', { error: err.message }));
  }, { timezone: 'Asia/Taipei' });

  logger.info('Weekly/monthly report jobs started');
}
