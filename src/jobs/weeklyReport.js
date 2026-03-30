// src/jobs/weeklyReport.js
import cron from 'node-cron';
import { query } from '../utils/db.js';
import { computePeriodRange, groupFrictions } from '../utils/report.js';
import logger from '../utils/logger.js';

const FRICTION_THRESHOLD = 3; // >= 3 次才建 issue

/**
 * 建立高頻 friction 的 project 記憶（去重）
 */
async function createFrictionIssues(userId, topFrictions, periodLabel) {
  let created = 0;
  for (const f of topFrictions) {
    if (f.count < FRICTION_THRESHOLD) continue;

    const key = f.text.toLowerCase().trim().slice(0, 20);
    // 逸脫 LIKE 特殊字元，避免 % 和 _ 干擾匹配
    const escapedKey = key.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const titlePrefix = `⚠️ 高頻 friction：`;
    const titleSnippet = f.text.slice(0, 50);

    // 檢查是否已存在（避免重複）
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
 * 執行週報 job（可傳入 userId 做單使用者處理，預設處理全部）
 */
export async function runWeeklyReport(targetUserId = null) {
  logger.info('週報 job 開始執行');
  const { start, end, label } = computePeriodRange('week', 1); // 上週

  try {
    // 取所有 active users（或指定 user）
    const usersResult = await query(
      targetUserId
        ? `SELECT id FROM users WHERE id = $1`
        : `SELECT id FROM users WHERE role IN ('admin', 'user')`,
      targetUserId ? [targetUserId] : []
    );

    for (const user of usersResult.rows) {
      const userId = user.id;

      // 取上週 session logs
      const sessions = await query(
        `SELECT details FROM session_logs
         WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3
           AND details IS NOT NULL AND details != '{}'::jsonb
           AND compressed = false`,
        [userId, start, end]
      );

      // 收集 friction / suggestions
      const frictions = sessions.rows
        .map(r => r.details?.friction_points)
        .filter(Boolean);
      const suggestions = sessions.rows
        .map(r => r.details?.suggestions)
        .filter(Boolean);

      const topFrictions = groupFrictions(frictions).slice(0, 10);
      const topSuggestions = groupFrictions(suggestions).slice(0, 10);

      // 建立高頻 friction issues
      const frictionIssuesCreated = await createFrictionIssues(userId, topFrictions, label);

      // 統計新增記憶數
      const memoriesResult = await query(
        `SELECT COUNT(*) as cnt FROM memories
         WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3
           AND status = 'active' AND NOT (tags @> ARRAY['pending_review'])`,
        [userId, start, end]
      );
      const newMemories = parseInt(memoriesResult.rows[0].cnt, 10);

      // 建週報快照（存 session_logs）
      // 轉成 Taipei 時間再算週數（start 是 UTC Sunday 16:00 = Taipei Monday 00:00）
      const taipeiStart = new Date(start.getTime() + 8 * 3600000);
      const weekNum = getWeekNumber(taipeiStart);
      const year = taipeiStart.getUTCFullYear();
      const title = `週報 ${year}-W${String(weekNum).padStart(2, '0')}`;

      // 去重：同 title 的週報不重複建立
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
              top_frictions: topFrictions.slice(0, 5),
              top_suggestions: topSuggestions.slice(0, 5),
            }),
          ]
        );
        logger.info(`週報建立完成: ${title}`, { userId, frictionIssuesCreated, newMemories });
      }
    }
  } catch (err) {
    logger.error('週報 job 失敗', { error: err.message });
  }
}

/**
 * 月報 job：聚合當月所有週報快照
 */
export async function runMonthlyReport(targetUserId = null) {
  logger.info('月報 job 開始執行');
  const { start, end, label } = computePeriodRange('month', 1); // 上月

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

      // 去重
      const existing = await query(
        `SELECT id FROM session_logs WHERE user_id = $1 AND summary = $2 LIMIT 1`,
        [userId, title]
      );
      if (existing.rows.length > 0) continue;

      // 聚合當月週報
      const weeklyReports = await query(
        `SELECT details FROM session_logs
         WHERE user_id = $1 AND tool = 'system' AND model = 'weekly-job'
           AND created_at >= $2 AND created_at <= $3`,
        [userId, start, end]
      );

      let newMemories = 0;
      let frictionIssuesCreated = 0;
      const allFrictions = [];
      const allSuggestions = [];

      for (const r of weeklyReports.rows) {
        const d = r.details;
        if (!d) continue;
        newMemories += d.new_memories || 0;
        frictionIssuesCreated += d.friction_issues_created || 0;
        // 保留 count：將 text 重複 count 次再 group，以正確加總
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
            top_frictions: groupFrictions(allFrictions).slice(0, 5),
            top_suggestions: groupFrictions(allSuggestions).slice(0, 5),
          }),
        ]
      );
      logger.info(`月報建立完成: ${title}`, { userId });
    }
  } catch (err) {
    logger.error('月報 job 失敗', { error: err.message });
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
 * 啟動定時 job
 * 週報：每週一 00:00 Asia/Taipei = UTC Sunday 16:00
 * 月報：每月 2 號 00:00 Asia/Taipei = UTC 1 號 16:00
 */
export function startJobs() {
  // 週報：UTC 週日 16:00 = Asia/Taipei 週一 00:00
  cron.schedule('0 16 * * 0', () => {
    runWeeklyReport().catch(err => logger.error('週報 cron 失敗', { error: err.message }));
  }, { timezone: 'UTC' });

  // 月報：UTC 每月 1 號 16:00 = Asia/Taipei 每月 2 號 00:00
  cron.schedule('0 16 1 * *', () => {
    runMonthlyReport().catch(err => logger.error('月報 cron 失敗', { error: err.message }));
  }, { timezone: 'UTC' });

  logger.info('週/月報 job 已啟動');
}
