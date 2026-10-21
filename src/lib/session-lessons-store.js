import { validateMemoryContent } from '../utils/memory-secret-guard.js';
import { lessonToMemory } from '../../shared/session-lessons.js';
import { LESSON_REPEAT, normalizeForSimilarity } from './memory-similarity.js';

/**
 * Store the lessons a closed session reported (v1.31.0), and promote the repeats (v1.33.0).
 *
 * Pulled out of the session route so it can be proved against a fake query: each lesson
 * is one row, a lesson that fails the same secret scan every `project` memory write runs
 * is counted and never stored, and a database without migration 027 costs the lessons but
 * not the session.
 *
 * v1.33.0: a lesson used to wait for the person to press 留下 on the console, and nobody
 * did. Now the second time the same thing is learned — an earlier `new` or `dismissed`
 * lesson of this person reads like this one (trigram similarity ≥ LESSON_REPEAT) — both
 * become one `project` memory at once, with no person in the loop. The rest wait for the
 * monthly consolidation card.
 *
 * @param {object} opts
 * @param {Function} opts.query
 * @param {object} [opts.logger]
 * @param {number} opts.userId
 * @param {number|null} opts.sessionLogId
 * @param {string|null} opts.project
 * @param {Array<{stuck: string, fix?: string, next_time?: string}>} opts.lessons  already normalised
 * @param {Function} [opts.sanitize]  the route's redaction of password-shaped text
 * @returns {Promise<{ saved: number, rejected: number, promoted: Array<{lesson_id: number, memory_id: number}> }>}
 */
export async function storeSessionLessons({
  query, logger = console, userId, sessionLogId, project, lessons, sanitize = (s) => s,
}) {
  let saved = 0;
  let rejected = 0;
  const promoted = [];
  const projectName = typeof project === 'string' && project ? project.slice(0, 255) : null;
  for (const lesson of lessons) {
    const content = [lesson.stuck, lesson.fix, lesson.next_time].filter(Boolean).join('\n');
    const check = validateMemoryContent({ type: 'project', title: lesson.stuck, content });
    if (!check.ok) { rejected += 1; continue; }
    const stuck = sanitize(lesson.stuck);
    const fix = lesson.fix ? sanitize(lesson.fix) : null;
    const nextTime = lesson.next_time ? sanitize(lesson.next_time) : null;
    let insertedId = null;
    try {
      const r = await query(
        `INSERT INTO session_lessons (user_id, session_log_id, project, stuck, fix, next_time)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [userId, sessionLogId, projectName, stuck, fix, nextTime],
      );
      saved += 1;
      insertedId = r.rows[0]?.id ?? null;
    } catch (err) {
      // A server whose database has not run migration 027 still records the session; it
      // just cannot keep the lessons, and says so in the count rather than failing.
      logger.error('session lesson insert failed', { error: err.message });
      continue;
    }
    if (insertedId === null) continue;
    try {
      const repeat = await findRepeatLesson(query, { userId, lessonId: insertedId, stuck, fix, nextTime });
      if (!repeat) continue;
      const newer = {
        id: insertedId, user_id: userId, session_log_id: sessionLogId, project: projectName,
        stuck, fix, next_time: nextTime,
      };
      const memoryId = await promoteLessonRow(query, {
        row: newer, userId, promotedBy: 'ai_repeat', repeatOf: repeat.id,
        extraLine: '（同一件事發生第二次）',
      });
      await markLessonPromoted(query, { lessonId: repeat.id, userId, memoryId, promotedBy: 'ai_repeat' });
      promoted.push({ lesson_id: insertedId, memory_id: memoryId });
    } catch (err) {
      // The lesson is stored either way; a database without pg_trgm or migration 034 only
      // loses the automatic promotion, which the monthly card catches.
      logger.error('session lesson repeat check failed', { error: err.message });
    }
  }
  return { saved, rejected, promoted };
}

/**
 * The earlier `new` or `dismissed` lesson of this person that says the same thing, or null.
 * Compared on all three answers: the problem is often reworded between sessions, and the
 * advice (`next_time`) is where two reports of one lesson agree most (see LESSON_REPEAT).
 */
export async function findRepeatLesson(query, { userId, lessonId, stuck, fix, nextTime }) {
  const text = normalizeForSimilarity(stuck, [fix, nextTime].filter(Boolean).join(' '));
  const r = await query(
    `SELECT id, user_id, session_log_id, project, stuck, fix, next_time, status,
            similarity(lower(stuck || ' ' || COALESCE(fix, '') || ' ' || COALESCE(next_time, '')), $3) AS similarity
       FROM session_lessons
      WHERE user_id = $1 AND id <> $2 AND status IN ('new', 'dismissed')
        AND similarity(lower(stuck || ' ' || COALESCE(fix, '') || ' ' || COALESCE(next_time, '')), $3) >= $4
      ORDER BY similarity DESC, id ASC
      LIMIT 1`,
    [userId, lessonId, text, LESSON_REPEAT],
  );
  return r.rows[0] || null;
}

/**
 * Turn one lesson row into a `project` memory and mark the row promoted. Shared by the
 * repeat path above and the two routes (`/promote`, `/set`) in src/routes/session-lessons.js,
 * so the memory a lesson becomes is one shape wherever the decision came from.
 *
 * The caller has already run the secret scan on the text (the store does it before the
 * insert; the routes do it before calling this), so nothing here re-reads the row.
 *
 * @returns {Promise<number>} the new memory's id
 */
export async function promoteLessonRow(query, { row, userId, promotedBy, reason = null, repeatOf = null, extraLine = null }) {
  const memory = lessonToMemory(row);
  const content = extraLine ? `${memory.content}\n${extraLine}` : memory.content;
  const metadata = {
    source: 'session_lesson', lesson_id: row.id, session_log_id: row.session_log_id ?? null, promoted_by: promotedBy,
    ...(repeatOf !== null && { repeat_of: repeatOf }),
  };
  const inserted = await query(
    `INSERT INTO memories (user_id, type, title, content, tags, metadata)
     VALUES ($1, 'project', $2, $3, $4, $5)
     RETURNING id, type, title, content, tags, created_at`,
    [userId, memory.title, content, memory.tags, metadata],
  );
  const memoryRow = inserted.rows[0];
  await query(
    `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
     VALUES ($1, 'session_lesson', 'create', $2, $3)`,
    [memoryRow.id, content, { source: 'session_lesson', lesson_id: row.id, promoted_by: promotedBy }],
  );
  await markLessonPromoted(query, { lessonId: row.id, userId, memoryId: memoryRow.id, promotedBy, reason });
  return memoryRow.id;
}

/** @returns {Promise<object|null>} the updated lesson row */
export async function markLessonPromoted(query, { lessonId, userId, memoryId, promotedBy, reason = null }) {
  const r = await query(
    `UPDATE session_lessons
        SET status = 'promoted', memory_id = $1, promoted_by = $2, reason = $3, resolved_at = NOW()
      WHERE id = $4 AND user_id = $5
      RETURNING *`,
    [memoryId, promotedBy, reason, lessonId, userId],
  );
  return r.rows[0] || null;
}
