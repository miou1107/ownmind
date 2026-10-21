import { Router } from 'express';
import { parseRowId } from '../utils/row-id.js';
import { validateMemoryContent } from '../utils/memory-secret-guard.js';
import {
  SIMILARITY_CANDIDATE, CONCLUDED_TITLE_REGEX, WAITING_REGEX, concludedMarker,
} from '../lib/memory-similarity.js';

/**
 * The monthly consolidation, server side (v1.33.0).
 *
 * The AI works a task card `整理記憶 YYYY-MM`; this router is what it reads and writes while
 * doing so. Everything here is computed in SQL and judged nowhere: the server lists what
 * looks like a duplicate, what reads as concluded, what has gone stale and what waits on
 * someone, and the AI — which has the subscription model — decides, action by action,
 * through the per-id routes in src/routes/memory.js.
 *
 *   GET  /candidates          the six groups, for the caller only
 *   POST /questions           park a question the AI cannot answer from the machine
 *   POST /questions/asked     a session showed these; at two showings the job archives
 *   PUT  /report-shown        the one-line report was rendered once
 *
 * Mounted at /api/memory/consolidation BEFORE /api/memory, so `/:id` never eats it. A
 * factory, so a test can hand it a fake query; the real-db test in
 * tests/ai-keeps-the-memory.test.js proves the SQL.
 */

/** Days a project memory may sit untouched before it is flagged (never auto-archived). */
export const STALE_DAYS = 90;
/** A `new` lesson older than this is listed on the card for the AI to keep or dismiss. */
export const LESSON_WAIT_DAYS = 7;
/** How many duplicate pairs a card lists at most. */
export const MAX_DUPLICATE_PAIRS = 50;
/** At most this many open questions reach a session at once. */
export const MAX_QUESTIONS = 3;

export const CARD_TITLE_PREFIX = '整理記憶 ';
export const CARD_PROJECT = 'ownmind';
export const UNANSWERED_ARCHIVE_REASON = '兩次未確認，自動歸檔';

/** The `project:<name>` tag of a memory, or null. */
export function projectOfTags(tags) {
  if (!Array.isArray(tags)) return null;
  const tag = tags.find((t) => typeof t === 'string' && t.startsWith('project:') && t.length > 8);
  return tag ? tag.slice(8) : null;
}

/** `YYYY-MM` of a moment in Asia/Taipei, the month a card is named after. */
export function taipeiMonth(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit' }).format(now);
}

/**
 * The six candidate groups for one user. Shared by the route and the job (which writes the
 * counts into the card body).
 */
export async function buildConsolidationCandidates(query, userId) {
  const [pairs, concluded, stale, waiting, lessons, closedTasks] = await Promise.all([
    query(
      `SELECT a.id AS a_id, a.title AS a_title, a.type AS a_type, a.updated_at AS a_updated_at,
              b.id AS b_id, b.title AS b_title, b.type AS b_type, b.updated_at AS b_updated_at,
              similarity(lower(a.title || ' ' || a.content), lower(b.title || ' ' || b.content)) AS similarity
         FROM memories a
         JOIN memories b
           ON b.user_id = a.user_id AND b.type = a.type AND b.status = 'active'
          AND b.is_test = FALSE AND a.id < b.id
        WHERE a.user_id = $1 AND a.status = 'active' AND a.is_test = FALSE
          AND similarity(lower(a.title || ' ' || a.content), lower(b.title || ' ' || b.content)) >= $2
        ORDER BY similarity DESC, a.id ASC
        LIMIT ${MAX_DUPLICATE_PAIRS}`,
      [userId, SIMILARITY_CANDIDATE],
    ),
    query(
      `SELECT id, title, updated_at FROM memories
        WHERE user_id = $1 AND type = 'project' AND status = 'active' AND is_test = FALSE
          AND title ~ $2
        ORDER BY updated_at ASC`,
      [userId, CONCLUDED_TITLE_REGEX],
    ),
    query(
      `SELECT id, title, updated_at,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400)::int AS days
         FROM memories
        WHERE user_id = $1 AND type = 'project' AND status = 'active' AND is_test = FALSE
          AND updated_at < NOW() - INTERVAL '1 day' * $2
          AND NOT (title ~ $3)
        ORDER BY updated_at ASC`,
      [userId, STALE_DAYS, CONCLUDED_TITLE_REGEX],
    ),
    query(
      `SELECT id, title, tags, created_at FROM memories
        WHERE user_id = $1 AND status = 'active' AND is_test = FALSE
          AND (title ~ $2 OR split_part(content, E'\\n', 1) ~ $2)
        ORDER BY created_at ASC`,
      [userId, WAITING_REGEX],
    ),
    query(
      `SELECT id, project, stuck, fix, next_time, created_at FROM session_lessons
        WHERE user_id = $1 AND status = 'new' AND created_at < NOW() - INTERVAL '1 day' * $2
        ORDER BY created_at ASC`,
      [userId, LESSON_WAIT_DAYS],
    ),
    query(
      `SELECT id, project, title, done_at FROM tasks
        WHERE user_id = $1 AND status IN ('done', 'reviewed')
          AND to_char(done_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM') = to_char(NOW() AT TIME ZONE 'Asia/Taipei', 'YYYY-MM')
        ORDER BY done_at DESC`,
      [userId],
    ),
  ]);
  return {
    duplicates: pairs.rows.map((r) => ({
      a: { id: r.a_id, title: r.a_title, type: r.a_type, updated_at: r.a_updated_at },
      b: { id: r.b_id, title: r.b_title, type: r.b_type, updated_at: r.b_updated_at },
      similarity: Number(r.similarity),
    })),
    concluded: concluded.rows.map((r) => ({ id: r.id, title: r.title, marker: concludedMarker(r.title), updated_at: r.updated_at })),
    stale: stale.rows.map((r) => ({ id: r.id, title: r.title, updated_at: r.updated_at, days: Number(r.days) })),
    waiting: waiting.rows.map((r) => ({ id: r.id, title: r.title, project: projectOfTags(r.tags), created_at: r.created_at })),
    lessons: lessons.rows.map((r) => ({
      id: r.id, project: r.project, stuck: r.stuck, fix: r.fix, next_time: r.next_time, created_at: r.created_at,
    })),
    closed_tasks: closedTasks.rows.map((r) => ({ id: r.id, project: r.project, title: r.title, done_at: r.done_at })),
  };
}

/**
 * Archive one memory row: status, timestamps, the history row, and the open question it
 * answers. Shared by the route (which checks access and the sync token first) and the job
 * (which archives after two unanswered showings). The caller has checked type and status.
 *
 * @returns {Promise<object|null>} the updated row, or null when nothing matched
 */
export async function archiveMemoryRow(query, { id, reason, changedBy = 'api', historyMetadata = {} }) {
  const r = await query(
    `UPDATE memories
        SET status = 'archived', archived_at = NOW(), archived_reason = $1, updated_at = NOW()
      WHERE id = $2 AND status = 'active'
      RETURNING *`,
    [reason, id],
  );
  const row = r.rows[0];
  if (!row) return null;
  await query(
    `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
     VALUES ($1, $2, 'archive', $3, $4)`,
    [id, changedBy, row.content, JSON.stringify({ reason, ...historyMetadata })],
  );
  await answerOpenQuestions(query, id);
  return row;
}

/** An archive or a decision settles whatever the AI was going to ask about that memory. */
export async function answerOpenQuestions(query, memoryId) {
  try {
    await query(
      'UPDATE consolidation_questions SET answered_at = NOW() WHERE memory_id = $1 AND answered_at IS NULL',
      [memoryId],
    );
  } catch {
    // A database without migration 034 has no questions to answer.
  }
}

/**
 * What `/init` says about the consolidation: the open card, the unshown report of the last
 * done card, and up to three questions. Each part inside its own try, so a database without
 * migration 034 (or 030) still answers init.
 */
export async function buildConsolidationState(query, userId, { logger = console } = {}) {
  const state = { card: null, report: null, questions: [] };
  try {
    const cards = await query(
      `SELECT id, title, status, created_at, done_at, report_shown_at FROM tasks
        WHERE user_id = $1 AND project = $2 AND title LIKE $3
          AND (status IN ('open', 'claimed') OR (status IN ('done', 'reviewed') AND report_shown_at IS NULL))
        ORDER BY created_at DESC`,
      [userId, CARD_PROJECT, `${CARD_TITLE_PREFIX}%`],
    );
    const open = cards.rows.find((c) => c.status === 'open' || c.status === 'claimed');
    if (open) state.card = { id: open.id, title: open.title, status: open.status, created_at: open.created_at };
    const done = cards.rows.find((c) => c.status === 'done' || c.status === 'reviewed');
    if (done) state.report = await buildConsolidationReport(query, userId, done);
  } catch (err) {
    logger.warn('consolidation card lookup failed', { error: err.message });
  }
  try {
    const qs = await query(
      `SELECT id, memory_id, project, question FROM consolidation_questions
        WHERE user_id = $1 AND answered_at IS NULL AND asked_count < 2
        ORDER BY created_at ASC
        LIMIT ${MAX_QUESTIONS}`,
      [userId],
    );
    state.questions = qs.rows;
  } catch (err) {
    logger.warn('consolidation questions lookup failed', { error: err.message });
  }
  return state;
}

/**
 * The counts behind `[OwnMind] 10 月的記憶整理完了：合併 N、歸檔 N、定案 N`. The month is the
 * card's own suffix; each merge writes two history rows, so they are halved.
 */
export async function buildConsolidationReport(query, userId, card) {
  const month = String(card.title).slice(CARD_TITLE_PREFIX.length).trim() || taipeiMonth(card.done_at ? new Date(card.done_at) : new Date());
  const [history, lessons, tasks] = await Promise.all([
    query(
      `SELECT (COUNT(*) FILTER (WHERE h.change_type = 'merge') / 2)::int AS merged,
              COUNT(*) FILTER (WHERE h.change_type = 'archive')::int AS archived,
              COUNT(*) FILTER (WHERE h.change_type = 'decide')::int AS decided
         FROM memory_history h JOIN memories m ON m.id = h.memory_id
        WHERE m.user_id = $1
          AND to_char(h.created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM') = $2`,
      [userId, month],
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM session_lessons
        WHERE user_id = $1 AND status = 'promoted' AND promoted_by LIKE 'ai_%'
          AND to_char(resolved_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM') = $2`,
      [userId, month],
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM tasks
        WHERE user_id = $1 AND status IN ('done', 'reviewed')
          AND to_char(done_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM') = $2`,
      [userId, month],
    ),
  ]);
  const h = history.rows[0] || {};
  return {
    task_id: card.id,
    month,
    merged: Number(h.merged) || 0,
    archived: Number(h.archived) || 0,
    decided: Number(h.decided) || 0,
    lessons_kept: Number(lessons.rows[0]?.n) || 0,
    closed_tasks: Number(tasks.rows[0]?.n) || 0,
  };
}

export function createMemoryConsolidationRouter({ query, auth, logger = console }) {
  const router = Router();
  router.use(auth);

  router.get('/candidates', async (req, res) => {
    try {
      res.json(await buildConsolidationCandidates(query, req.user.id));
    } catch (err) {
      logger.error('consolidation candidates failed', { error: err.message });
      res.status(500).json({ error: 'Failed to list consolidation candidates' });
    }
  });

  /**
   * POST /questions { memory_id, question } — one open question per memory; a second call
   * for the same memory replaces the text and resets nothing else. Answers 201 with the row
   * either way, so the MCP tool has one shape to relay.
   */
  router.post('/questions', async (req, res) => {
    try {
      const memoryId = req.body?.memory_id;
      const question = typeof req.body?.question === 'string' ? req.body.question.trim().slice(0, 2000) : '';
      if (!parseRowId(memoryId).ok) return res.status(400).json({ error: 'memory_id is required' });
      if (!question) return res.status(400).json({ error: 'question is required' });
      const memory = await query(
        'SELECT id, type, title, tags FROM memories WHERE id = $1 AND user_id = $2',
        [memoryId, req.user.id],
      );
      if (memory.rows.length === 0) return res.status(404).json({ error: 'Memory not found' });
      // The question is rendered into every session's context; the same guard every memory
      // write runs keeps a pasted key out of it.
      const guardResult = validateMemoryContent({ type: memory.rows[0].type, title: memory.rows[0].title, content: question });
      if (!guardResult.ok) return res.status(guardResult.status).json(guardResult.body);
      const project = (typeof req.body?.project === 'string' && req.body.project.trim().slice(0, 255))
        || projectOfTags(memory.rows[0].tags);
      const existing = await query(
        `UPDATE consolidation_questions SET question = $1, project = COALESCE($2, project)
          WHERE memory_id = $3 AND user_id = $4 AND answered_at IS NULL
          RETURNING *`,
        [question, project, memoryId, req.user.id],
      );
      if (existing.rows[0]) return res.status(201).json(existing.rows[0]);
      const inserted = await query(
        `INSERT INTO consolidation_questions (user_id, memory_id, project, question)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [req.user.id, memoryId, project, question],
      );
      res.status(201).json(inserted.rows[0]);
    } catch (err) {
      logger.error('consolidation question failed', { error: err.message });
      res.status(500).json({ error: 'Failed to store the question' });
    }
  });

  /**
   * POST /questions/asked { ids } — a session rendered these; count the showing.
   *
   * The hook reports on every session start, `/compact` and resume included, so one
   * morning of restarts would otherwise reach `asked_count >= 2` and the job would archive
   * the memory before the person ever read the question. A showing counts once per
   * calendar day (Asia/Taipei); `last_asked_at` moves on every call so the 14-day clock
   * still starts from the latest showing.
   */
  router.post('/questions/asked', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
        : [];
      if (ids.length === 0) return res.json({ updated: 0 });
      const r = await query(
        `UPDATE consolidation_questions
            SET asked_count = asked_count + CASE
                  WHEN last_asked_at IS NULL
                    OR (last_asked_at AT TIME ZONE 'Asia/Taipei')::date <> (NOW() AT TIME ZONE 'Asia/Taipei')::date
                  THEN 1 ELSE 0 END,
                last_asked_at = NOW()
          WHERE id = ANY($1::int[]) AND user_id = $2 AND answered_at IS NULL
          RETURNING id`,
        [ids, req.user.id],
      );
      res.json({ updated: r.rows.length });
    } catch (err) {
      logger.error('consolidation questions/asked failed', { error: err.message });
      res.status(500).json({ error: 'Failed to mark the questions asked' });
    }
  });

  /** PUT /report-shown { task_id } — the one-line report went out once; do not repeat it. */
  router.put('/report-shown', async (req, res) => {
    try {
      const taskId = req.body?.task_id;
      if (!parseRowId(taskId).ok) return res.status(400).json({ error: 'task_id is required' });
      const r = await query(
        `UPDATE tasks SET report_shown_at = NOW()
          WHERE id = $1 AND user_id = $2 AND project = $3 AND title LIKE $4
          RETURNING id`,
        [taskId, req.user.id, CARD_PROJECT, `${CARD_TITLE_PREFIX}%`],
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'Consolidation card not found' });
      res.json({ ok: true });
    } catch (err) {
      logger.error('consolidation report-shown failed', { error: err.message });
      res.status(500).json({ error: 'Failed to mark the report shown' });
    }
  });

  return router;
}
