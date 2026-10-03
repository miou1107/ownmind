import { validateMemoryContent } from '../utils/memory-secret-guard.js';

/**
 * Store the lessons a closed session reported (v1.31.0).
 *
 * Pulled out of the session route so it can be proved against a fake query: each lesson
 * is one row, a lesson that fails the same secret scan every `project` memory write runs
 * is counted and never stored, and a database without migration 027 costs the lessons but
 * not the session.
 *
 * @param {object} opts
 * @param {Function} opts.query
 * @param {object} [opts.logger]
 * @param {number} opts.userId
 * @param {number|null} opts.sessionLogId
 * @param {string|null} opts.project
 * @param {Array<{stuck: string, fix?: string, next_time?: string}>} opts.lessons  already normalised
 * @param {Function} [opts.sanitize]  the route's redaction of password-shaped text
 * @returns {Promise<{ saved: number, rejected: number }>}
 */
export async function storeSessionLessons({
  query, logger = console, userId, sessionLogId, project, lessons, sanitize = (s) => s,
}) {
  let saved = 0;
  let rejected = 0;
  const projectName = typeof project === 'string' && project ? project.slice(0, 255) : null;
  for (const lesson of lessons) {
    const content = [lesson.stuck, lesson.fix, lesson.next_time].filter(Boolean).join('\n');
    const check = validateMemoryContent({ type: 'project', title: lesson.stuck, content });
    if (!check.ok) { rejected += 1; continue; }
    try {
      await query(
        `INSERT INTO session_lessons (user_id, session_log_id, project, stuck, fix, next_time)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, sessionLogId, projectName, sanitize(lesson.stuck),
          lesson.fix ? sanitize(lesson.fix) : null,
          lesson.next_time ? sanitize(lesson.next_time) : null],
      );
      saved += 1;
    } catch (err) {
      // A server whose database has not run migration 027 still records the session; it
      // just cannot keep the lessons, and says so in the count rather than failing.
      logger.error('session lesson insert failed', { error: err.message });
    }
  }
  return { saved, rejected };
}
