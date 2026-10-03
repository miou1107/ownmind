import { Router } from 'express';
import { validateMemoryContent } from '../utils/memory-secret-guard.js';
import { lessonToMemory } from '../../shared/session-lessons.js';
import { parseRowId } from '../utils/row-id.js';

/**
 * The lessons a session left behind, and what the person decides to do with them (v1.31.0).
 *
 * Rows arrive through POST /api/session (src/routes/session.js) when the AI closes a
 * conversation with `lessons`. This router is the other half: list what is waiting, turn one
 * into a memory, or let it go. Nothing here writes a memory on its own — promotion is the
 * person's click, because a memory table that fills itself from every session is a log, and
 * a log is what the AI already fails to read.
 *
 * Built as a factory, like me-narrative.js, so a test can hand it a fake `query` and prove
 * the three decisions without a database.
 */

const STATUSES = new Set(['new', 'promoted', 'dismissed', 'all']);
const DEFAULT_DAYS = 30;
const MAX_ROWS = 200;

/** The three answers, joined, so one secret scan covers everything that would be stored. */
function lessonText(row) {
  return [row.stuck, row.fix, row.next_time].filter(Boolean).join('\n');
}

export function createSessionLessonsRouter({ query, auth, logger = console }) {
  const router = Router();

  // The same guard the handoff router carries: a non-numeric id is "not found", not a 500.
  router.param('id', (req, res, next, raw) => {
    if (!parseRowId(raw).ok) return res.status(404).json({ error: 'Lesson not found' });
    next();
  });
  router.use(auth);

  /**
   * GET / — this person's lessons.
   *   ?status=new|promoted|dismissed|all   default new
   *   ?days=30                              window on created_at; ignored for status=new,
   *                                         because a lesson nobody has looked at does not
   *                                         stop waiting just because it got old
   */
  router.get('/', async (req, res) => {
    try {
      const status = STATUSES.has(req.query.status) ? req.query.status : 'new';
      const days = Number.parseInt(req.query.days, 10);
      const window = Number.isInteger(days) && days > 0 ? days : DEFAULT_DAYS;
      const where = ['user_id = $1'];
      const values = [req.user.id];
      if (status !== 'all') { values.push(status); where.push(`status = $${values.length}`); }
      if (status !== 'new') { values.push(window); where.push(`created_at >= NOW() - INTERVAL '1 day' * $${values.length}`); }
      const result = await query(
        `SELECT id, session_log_id, project, stuck, fix, next_time, status, memory_id,
                created_at, resolved_at
           FROM session_lessons
          WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT ${MAX_ROWS}`,
        values,
      );
      res.json(result.rows);
    } catch (err) {
      logger.error('session lessons query failed', { error: err.message });
      res.status(500).json({ error: 'Query failed' });
    }
  });

  /**
   * PUT /:id/promote — make this lesson a memory of type `project`.
   *
   * The lesson has to be this person's and still `new`; a row already promoted or dismissed
   * is answered 409 rather than silently promoted twice. The scan is the same one every
   * memory write runs: a lesson that quotes a key is refused, with the reason and no text.
   */
  router.put('/:id/promote', async (req, res) => {
    try {
      const found = await query(
        'SELECT * FROM session_lessons WHERE id = $1 AND user_id = $2',
        [req.params.id, req.user.id],
      );
      const row = found.rows[0];
      if (!row) return res.status(404).json({ error: 'Lesson not found' });
      if (row.status !== 'new') {
        return res.status(409).json({ error: 'Lesson already resolved', status: row.status });
      }

      const memory = lessonToMemory(row);
      // The same scan every memory write runs (narrative types skip the keyword heuristic),
      // so a lesson is refused here exactly when POST /api/memory would refuse it. The
      // answer carries the rule and nothing of the text.
      const check = validateMemoryContent({ type: 'project', title: memory.title, content: memory.content });
      if (!check.ok) {
        return res.status(400).json({ error: 'Lesson looks like it contains a secret', rule: check.body?.detected_by || 'secret' });
      }
      const inserted = await query(
        `INSERT INTO memories (user_id, type, title, content, tags, metadata)
         VALUES ($1, 'project', $2, $3, $4, $5)
         RETURNING id, type, title, content, tags, created_at`,
        [req.user.id, memory.title, memory.content, memory.tags,
          { source: 'session_lesson', lesson_id: row.id, session_log_id: row.session_log_id }],
      );
      const memoryRow = inserted.rows[0];
      await query(
        `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
         VALUES ($1, 'session_lesson', 'create', $2, $3)`,
        [memoryRow.id, memory.content, { source: 'session_lesson', lesson_id: row.id }],
      );
      const updated = await query(
        `UPDATE session_lessons
            SET status = 'promoted', memory_id = $1, resolved_at = NOW()
          WHERE id = $2 AND user_id = $3
          RETURNING *`,
        [memoryRow.id, row.id, req.user.id],
      );
      res.json({ lesson: updated.rows[0], memory: memoryRow });
    } catch (err) {
      logger.error('session lesson promote failed', { error: err.message });
      res.status(500).json({ error: 'Failed to promote lesson' });
    }
  });

  /** PUT /:id/dismiss — the lesson was not worth keeping. Only a `new` row can be dismissed. */
  router.put('/:id/dismiss', async (req, res) => {
    try {
      const updated = await query(
        `UPDATE session_lessons
            SET status = 'dismissed', resolved_at = NOW()
          WHERE id = $1 AND user_id = $2 AND status = 'new'
          RETURNING *`,
        [req.params.id, req.user.id],
      );
      if (updated.rows.length === 0) return res.status(404).json({ error: 'Lesson not found' });
      res.json(updated.rows[0]);
    } catch (err) {
      logger.error('session lesson dismiss failed', { error: err.message });
      res.status(500).json({ error: 'Failed to dismiss lesson' });
    }
  });

  return router;
}
