import { Router } from 'express';
import { validateMemoryContent } from '../utils/memory-secret-guard.js';
import { lessonToMemory } from '../../shared/session-lessons.js';
import { parseRowId } from '../utils/row-id.js';
import { generateSyncToken } from '../utils/syncToken.js';
import { promoteLessonRow, markLessonPromoted } from '../lib/session-lessons-store.js';

/**
 * The lessons a session left behind, and what became of them (v1.31.0, reworked v1.33.0).
 *
 * Rows arrive through POST /api/session (src/routes/session.js) when the AI closes a
 * conversation with `lessons`. This router is the other half: list them, turn one into a
 * memory, or let it go.
 *
 * v1.33.0: promotion is no longer the person's click. The store promotes a repeated lesson
 * on insert, the AI works the rest at the monthly consolidation card through `/:id/set`,
 * and the console only shows what was decided and offers the undo (收回 archives the memory;
 * 還是留 calls `/set` with `promoted`). `/promote` and `/dismiss` stay for older consoles.
 *
 * Built as a factory, like me-narrative.js, so a test can hand it a fake `query` and prove
 * the decisions without a database.
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
                reason, promoted_by, created_at, resolved_at
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
   * PUT /:id/promote — make this lesson a memory of type `project` (older consoles).
   *
   * The lesson has to be this person's and still `new`; a row already promoted or dismissed
   * is answered 409 rather than silently promoted twice.
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
      await promote(req, res, row, { promotedBy: 'console', reason: null });
    } catch (err) {
      logger.error('session lesson promote failed', { error: err.message });
      res.status(500).json({ error: 'Failed to promote lesson' });
    }
  });

  /**
   * Promote one row the caller owns: the same scan every memory write runs (a lesson that
   * quotes a key is refused with the reason and no text), then the store's helper writes the
   * project memory, its history row and the lesson's new status. The answer is built from
   * what was written rather than read back, so the three statements are the whole cost.
   */
  async function promote(req, res, row, { promotedBy, reason }) {
    const memory = lessonToMemory(row);
    const check = validateMemoryContent({ type: 'project', title: memory.title, content: memory.content });
    if (!check.ok) {
      return res.status(400).json({ error: 'Lesson looks like it contains a secret', rule: check.body?.detected_by || 'secret' });
    }
    const memoryId = await promoteLessonRow(query, { row, userId: req.user.id, promotedBy, reason });
    res.json({
      lesson: { ...row, status: 'promoted', memory_id: memoryId, promoted_by: promotedBy, reason: reason ?? row.reason ?? null },
      memory: { id: memoryId, type: 'project', title: memory.title, content: memory.content, tags: memory.tags },
    });
  }
  /**
   * Promote a lesson that already made a memory once: the console's pull-back archived that
   * memory and dismissed the row; keep-anyway brings the same memory back rather than
   * writing a second copy beside the archived one. Returns true when it handled the request.
   *
   *   archived  -> restored (active, archived_* cleared, history row `restore`, fresh sync
   *                token: the same writes as POST /api/memory/:id/restore)
   *   active    -> the lesson is re-linked to it; nothing in `memories` moves
   *   otherwise -> false: disabled or deleted, so the caller writes a new memory as before
   */
  async function promoteByRestoring(req, res, row, { promotedBy, reason }) {
    if (!parseRowId(row.memory_id).ok) return false;
    const found = await query(
      'SELECT id, status, archived_reason FROM memories WHERE id = $1 AND user_id = $2',
      [row.memory_id, req.user.id],
    );
    const memory = found.rows[0];
    if (!memory || (memory.status !== 'archived' && memory.status !== 'active')) return false;
    let memoryRow = memory;
    let restored = false;
    if (memory.status === 'archived') {
      const r = await query(
        `UPDATE memories
            SET status = 'active', archived_at = NULL, archived_reason = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'archived'
          RETURNING *`,
        [memory.id],
      );
      if (r.rows.length === 0) return false;
      memoryRow = r.rows[0];
      restored = true;
      await query(
        `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
         VALUES ($1, 'session_lesson', 'restore', $2, $3)`,
        [memory.id, memoryRow.content, JSON.stringify({ archived_reason: memory.archived_reason ?? null, lesson_id: row.id, promoted_by: promotedBy })],
      );
    }
    const lesson = await markLessonPromoted(query, { lessonId: row.id, userId: req.user.id, memoryId: memory.id, promotedBy, reason });
    const response = {
      lesson: lesson || { ...row, status: 'promoted', memory_id: memory.id, promoted_by: promotedBy, reason },
      memory: memoryRow,
    };
    if (restored) response.sync_token = await generateSyncToken(req.user.id, query);
    res.json(response);
    return true;
  }

  /**
   * PUT /:id/set — the AI's (or the console's) verdict on a lesson (v1.33.0).
   *   { status: 'promoted', reason? }   any status but promoted -> one project memory;
   *                                     signed ai_monthly when the MCP calls (x-ownmind-tool
   *                                     header), console otherwise. A row whose memory was
   *                                     archived gets that memory restored instead (see
   *                                     promoteByRestoring)
   *   { status: 'dismissed', reason }   -> dismissed with the reason stored; the reason is
   *                                     required, the console shows it next to the lesson.
   *                                     A promoted lesson may be dismissed too (the console's
   *                                     pull-back archives the memory first, then dismisses);
   *                                     its memory_id stays so the row still points at what
   *                                     it made
   */
  router.put('/:id/set', async (req, res) => {
    try {
      const status = req.body?.status;
      if (status !== 'promoted' && status !== 'dismissed') {
        return res.status(400).json({ error: 'status must be promoted or dismissed' });
      }
      const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 1000) : null;
      if (status === 'dismissed' && !reason) {
        return res.status(400).json({ error: 'reason is required when dismissing a lesson' });
      }
      const found = await query(
        'SELECT * FROM session_lessons WHERE id = $1 AND user_id = $2',
        [req.params.id, req.user.id],
      );
      const row = found.rows[0];
      if (!row) return res.status(404).json({ error: 'Lesson not found' });
      if (status === 'promoted') {
        if (row.status === 'promoted') {
          return res.status(409).json({ error: 'Lesson already promoted', status: row.status, memory_id: row.memory_id });
        }
        const promotedBy = req.headers['x-ownmind-tool'] ? 'ai_monthly' : 'console';
        if (await promoteByRestoring(req, res, row, { promotedBy, reason })) return;
        return await promote(req, res, row, { promotedBy, reason });
      }
      // memory_id is deliberately left as it is: a dismissed-after-promotion row keeps
      // pointing at the memory the console just archived, so 還是留 can find it again.
      const updated = await query(
        `UPDATE session_lessons
            SET status = 'dismissed', reason = $1, resolved_at = NOW()
          WHERE id = $2 AND user_id = $3
          RETURNING *`,
        [reason, row.id, req.user.id],
      );
      res.json(updated.rows[0] || { ...row, status: 'dismissed', reason });
    } catch (err) {
      logger.error('session lesson set failed', { error: err.message });
      res.status(500).json({ error: 'Failed to set lesson' });
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
