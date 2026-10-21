/**
 * memory-consolidation.js — the monthly card and the unanswered questions (v1.33.0),
 * daily at 04:10 Asia/Taipei plus once at start-up.
 *
 * The server does not consolidate anything itself; it has no model. It writes one task
 * card `整理記憶 YYYY-MM` per user with memories, and any session that starts picks the card
 * up (the session-start context says so). Running daily rather than monthly means a server
 * that was down on the 1st still writes the card on the 2nd, and a card is never written
 * twice for the same month.
 *
 * The second duty: a question the AI parked and showed twice with no answer, 14 days on, is
 * settled by archiving the memory (project type only) with 兩次未確認，自動歸檔. The question
 * is marked answered either way, so it never blocks newer ones.
 */

import cron from 'node-cron';
import { query as defaultQuery } from '../utils/db.js';
import logger from '../utils/logger.js';
import {
  buildConsolidationCandidates, archiveMemoryRow, taipeiMonth,
  CARD_TITLE_PREFIX, CARD_PROJECT, UNANSWERED_ARCHIVE_REASON,
} from '../routes/memory-consolidation.js';

/** Days after the second showing before an unanswered question settles itself. */
export const UNANSWERED_QUESTION_DAYS = 14;

export const SKILL_LINE = '規則照 ownmind-consolidate 這個 skill 做';
export const FIRST_CALL_LINE = '先呼叫 ownmind_consolidation_candidates';

/** The card body: what the server counted, then the two fixed lines the AI starts from. */
export function cardBody(counts) {
  return [
    `這個月的記憶整理。候選：重複的在候選清單裡算、已結案 ${counts.concluded.length} 條、`
      + `超過 90 天沒更新 ${counts.stale.length} 條、在等回覆 ${counts.waiting.length} 條、`
      + `教訓 ${counts.lessons.length} 則、本月關掉的卡 ${counts.closed_tasks.length} 張。`,
    SKILL_LINE,
    FIRST_CALL_LINE,
  ].join('\n');
}

export async function runMemoryConsolidation({ query = defaultQuery, now = new Date() } = {}) {
  const month = taipeiMonth(now);
  const title = `${CARD_TITLE_PREFIX}${month}`;

  // Users with at least one active memory and no card for this month yet.
  const users = await query(
    `SELECT DISTINCT m.user_id
       FROM memories m
      WHERE m.status = 'active' AND m.is_test = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
           WHERE t.user_id = m.user_id AND t.project = $1 AND t.title = $2)
      ORDER BY m.user_id`,
    [CARD_PROJECT, title],
  );
  const created = [];
  for (const { user_id: userId } of users.rows) {
    const counts = await buildConsolidationCandidates(query, userId, { pairs: false });
    // Check-then-insert races with another run of this job (start-up plus cron, or two
    // servers); the partial unique index in db/034 decides, and the loser writes nothing.
    // The conflict target must spell the index predicate, so it is built from the same
    // constants the index was written from.
    const inserted = await query(
      `INSERT INTO tasks (user_id, project, title, body, auto, is_private)
       VALUES ($1, $2, $3, $4, TRUE, TRUE)
       ON CONFLICT (user_id, title) WHERE project = '${CARD_PROJECT}' AND title LIKE '${CARD_TITLE_PREFIX}%' DO NOTHING
       RETURNING id`,
      [userId, CARD_PROJECT, title, cardBody(counts)],
    );
    if (inserted.rows.length > 0) created.push(userId);
  }

  // Questions shown twice and left unanswered for two weeks.
  const stale = await query(
    `SELECT q.id, q.memory_id, m.type, m.status
       FROM consolidation_questions q JOIN memories m ON m.id = q.memory_id
      WHERE q.answered_at IS NULL AND q.asked_count >= 2
        AND q.last_asked_at < NOW() - INTERVAL '1 day' * $1
      ORDER BY q.id`,
    [UNANSWERED_QUESTION_DAYS],
  );
  const expired = [];
  for (const q of stale.rows) {
    if (q.type === 'project' && q.status === 'active') {
      const row = await archiveMemoryRow(query, {
        id: q.memory_id, reason: UNANSWERED_ARCHIVE_REASON, changedBy: 'consolidation_job',
        historyMetadata: { question_id: q.id },
      });
      if (row) expired.push(q.memory_id);
    }
    // archiveMemoryRow answers the question; a non-project memory's question is answered
    // here so it stops counting against the three-question limit.
    await query('UPDATE consolidation_questions SET answered_at = NOW() WHERE id = $1 AND answered_at IS NULL', [q.id]);
  }

  logger.info('memory consolidation finished', { month, created: created.length, expired: expired.length });
  return { month, created, expired };
}

export function startMemoryConsolidationJob() {
  cron.schedule('10 4 * * *', () => {
    runMemoryConsolidation().catch((err) =>
      logger.error('memory consolidation cron failed', { error: err.message }));
  }, { timezone: 'Asia/Taipei' });
  // Once at boot too: a server that was down on the 1st writes the month's card now rather
  // than tomorrow at 04:10. Idempotent — the card exists or it does not.
  runMemoryConsolidation().catch((err) =>
    logger.error('memory consolidation startup run failed', { error: err.message }));
  logger.info('memory consolidation job started (daily 04:10 Asia/Taipei)');
}
