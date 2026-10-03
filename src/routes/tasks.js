import { Router } from 'express';
import { parseRowId } from '../utils/row-id.js';
import { isAtLeast } from '../middleware/adminAuth.js';
import {
  normalizeTaskCreate, normalizeTaskDone, claimNote, CLAIM_TTL_HOURS, TASK_STATUSES,
} from '../../shared/task-body.js';

/**
 * Task cards an AI session can pick up (v1.31.3).
 *
 *   POST   /             create (the AI writes the card the person asked for)
 *   GET    /             list: ?project=  open+claimed cards of a project the caller may see
 *                              ?mine=true  cards the caller owns or holds, not yet closed
 *                              ?all=true   admin+: every non-private card, any status
 *   PUT    /:id/claim    take an open card (or move my own claim to this session)
 *   PUT    /:id/done     finish the card I hold
 *   PUT    /:id/drop     hand back the card I hold, with a reason
 *   PUT    /:id/review   close a done card — owner or admin, from the console only
 *
 * Visibility is one predicate (`visibleWhere`): a private card is seen by its owner and its
 * holder and nobody else. The MCP offers no review tool on purpose; the AI never closes its
 * own work.
 *
 * A factory, so a test can hand it a fake `query` and prove the claim races, the visibility
 * rule and the status machine without a database.
 */

const LIST_LIMIT = 50;

/** SQL fragment: rows the caller may see. `$n` is the parameter slot for the caller's id. */
function visibleWhere(alias, slot) {
  return `(${alias}.is_private = FALSE OR ${alias}.user_id = ${slot} OR ${alias}.claimed_by = ${slot})`;
}

const CARD_COLUMNS = `
  t.id, t.user_id, t.project, t.title, t.body, t.status, t.is_private, t.auto, t.links,
  t.claimed_by, t.claimed_tool, t.claimed_session, t.claimed_at, t.result, t.done_at,
  t.reviewed_by, t.reviewed_at, t.created_at, t.updated_at,
  owner.name AS owner_name, holder.name AS holder_name`;

// What a list carries by default: enough to pick a card, never the 4000-character body of
// fifty of them into the AI's context. `?full=true` (the console) gets CARD_COLUMNS.
const LIST_COLUMNS = `
  t.id, t.user_id, t.project, t.title, t.status, t.is_private, t.auto, t.links,
  t.claimed_by, t.claimed_at, t.done_at, t.created_at, t.updated_at,
  owner.name AS owner_name, holder.name AS holder_name`;

const CARD_JOINS = `
  FROM tasks t
  LEFT JOIN users owner ON owner.id = t.user_id
  LEFT JOIN users holder ON holder.id = t.claimed_by`;

export function createTasksRouter({ query, auth, logger = console }) {
  const router = Router();

  router.param('id', (req, res, next, raw) => {
    if (!parseRowId(raw).ok) return res.status(404).json({ error: 'Task not found' });
    next();
  });
  router.use(auth);

  async function findVisible(id, userId) {
    const r = await query(
      `SELECT ${CARD_COLUMNS} ${CARD_JOINS} WHERE t.id = $1 AND ${visibleWhere('t', '$2')}`,
      [id, userId],
    );
    return r.rows[0] || null;
  }

  router.post('/', async (req, res) => {
    try {
      const n = normalizeTaskCreate(req.body);
      if (!n.ok) return res.status(400).json({ error: n.error });
      const { project, title, body, links, auto, is_private } = n.task;
      const r = await query(
        `INSERT INTO tasks (user_id, project, title, body, links, auto, is_private)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, project, title, status, is_private, auto, links, created_at`,
        [req.user.id, project, title, body, links, auto, is_private],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      logger.error('task create failed', { error: err.message });
      res.status(500).json({ error: 'Failed to create task' });
    }
  });

  router.get('/', async (req, res) => {
    try {
      const uid = req.user.id;
      const columns = req.query.full === 'true' ? CARD_COLUMNS : LIST_COLUMNS;
      // Each branch builds its own parameter list: Postgres refuses a statement that is
      // handed a parameter it never references, so `values` cannot start with the caller's
      // id for the one branch that does not filter on it.
      let where;
      let values;
      if (req.query.all === 'true') {
        if (!isAtLeast(req.user.role, 'admin')) return res.status(403).json({ error: 'Admin only' });
        where = 't.is_private = FALSE';
        values = [];
        if (TASK_STATUSES.includes(req.query.status)) { values.push(req.query.status); where += ` AND t.status = $${values.length}`; }
      } else if (req.query.mine === 'true') {
        values = [uid];
        where = `(t.user_id = $1 OR t.claimed_by = $1) AND t.status NOT IN ('reviewed', 'dropped')`;
      } else {
        const project = typeof req.query.project === 'string' ? req.query.project.trim() : '';
        if (!project) return res.status(400).json({ error: 'project, mine=true or all=true is required' });
        values = [uid, project];
        where = `t.project = $2 AND ${visibleWhere('t', '$1')} AND t.status IN ('open', 'claimed')`;
      }
      // "Held by me" is decided here, so a client never has to know its own account id. The
      // all branch carries no caller parameter, so it answers FALSE rather than reference $1.
      const heldByMe = req.query.all === 'true' ? 'FALSE' : '(t.claimed_by = $1)';
      const r = await query(
        `SELECT ${columns}, ${heldByMe} AS held_by_me ${CARD_JOINS} WHERE ${where}
          ORDER BY CASE t.status WHEN 'claimed' THEN 0 WHEN 'open' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
                   t.created_at ASC
          LIMIT ${LIST_LIMIT}`,
        values,
      );
      res.json(r.rows);
    } catch (err) {
      logger.error('task list failed', { error: err.message });
      res.status(500).json({ error: 'Query failed' });
    }
  });

  router.put('/:id/claim', async (req, res) => {
    try {
      const uid = req.user.id;
      const tool = typeof req.body?.tool === 'string' ? req.body.tool.slice(0, 100) : null;
      const session = typeof req.body?.session_id === 'string' ? req.body.session_id.slice(0, 100) : null;
      // One statement decides: open, or already mine from another session.
      const r = await query(
        `UPDATE tasks SET status = 'claimed', claimed_by = $2, claimed_tool = $3, claimed_session = $4,
                claimed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND ${visibleWhere('tasks', '$2')}
            AND (status = 'open' OR (status = 'claimed' AND claimed_by = $2))
          RETURNING id, project, title, status, claimed_by, claimed_at, claimed_session`,
        [req.params.id, uid, tool, session],
      );
      if (r.rows[0]) return res.json(r.rows[0]);
      const row = await findVisible(req.params.id, uid);
      if (!row) return res.status(404).json({ error: 'Task not found' });
      if (row.status === 'claimed') {
        // The name and the time go into `error` itself: the MCP client relays that field to
        // the AI and nothing else, so a 409 that only carried them beside it read as a bare
        // "already claimed".
        const who = row.holder_name || 'someone else';
        const at = row.claimed_at ? new Date(row.claimed_at) : null;
        const since = at && !Number.isNaN(at.getTime()) ? ` since ${at.toISOString()}` : '';
        return res.status(409).json({ error: `Task already claimed by ${who}${since}`, claimed_by: row.holder_name, claimed_at: row.claimed_at });
      }
      return res.status(409).json({ error: 'Task is not open', status: row.status });
    } catch (err) {
      logger.error('task claim failed', { error: err.message });
      res.status(500).json({ error: 'Failed to claim task' });
    }
  });

  router.put('/:id/done', async (req, res) => {
    try {
      const n = normalizeTaskDone(req.body);
      if (!n.ok) return res.status(400).json({ error: n.error });
      const r = await query(
        `UPDATE tasks SET status = 'done', result = $3, links = links || $4::jsonb, done_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'claimed' AND claimed_by = $2
          RETURNING id, project, title, status, result, links, done_at`,
        [req.params.id, req.user.id, n.result, JSON.stringify(n.links)],
      );
      if (r.rows[0]) return res.json(r.rows[0]);
      const row = await findVisible(req.params.id, req.user.id);
      if (!row) return res.status(404).json({ error: 'Task not found' });
      return res.status(403).json({ error: 'Only the holder of a claimed task can finish it', status: row.status, claimed_by: row.holder_name });
    } catch (err) {
      logger.error('task done failed', { error: err.message });
      res.status(500).json({ error: 'Failed to finish task' });
    }
  });

  router.put('/:id/drop', async (req, res) => {
    try {
      const note = claimNote('dropped', { name: req.user.name, reason: req.body?.reason, at: new Date() });
      const r = await query(
        `UPDATE tasks SET status = 'open', body = body || $3, claimed_by = NULL, claimed_tool = NULL,
                claimed_session = NULL, claimed_at = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'claimed' AND claimed_by = $2
          RETURNING id, project, title, status`,
        [req.params.id, req.user.id, note],
      );
      if (r.rows[0]) return res.json(r.rows[0]);
      const row = await findVisible(req.params.id, req.user.id);
      if (!row) return res.status(404).json({ error: 'Task not found' });
      return res.status(403).json({ error: 'Only the holder of a claimed task can drop it', status: row.status });
    } catch (err) {
      logger.error('task drop failed', { error: err.message });
      res.status(500).json({ error: 'Failed to drop task' });
    }
  });

  router.put('/:id/review', async (req, res) => {
    try {
      const uid = req.user.id;
      const row = await findVisible(req.params.id, uid);
      if (!row) return res.status(404).json({ error: 'Task not found' });
      if (row.user_id !== uid && !isAtLeast(req.user.role, 'admin')) {
        return res.status(403).json({ error: 'Only the owner or an admin can review a task' });
      }
      if (row.status !== 'done') return res.status(409).json({ error: 'Only a done task can be reviewed', status: row.status });
      const r = await query(
        `UPDATE tasks SET status = 'reviewed', reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'done'
          RETURNING id, project, title, status, reviewed_by, reviewed_at`,
        [req.params.id, uid],
      );
      res.json(r.rows[0]);
    } catch (err) {
      logger.error('task review failed', { error: err.message });
      res.status(500).json({ error: 'Failed to review task' });
    }
  });

  return router;
}

/**
 * Hand back cards whose claim is older than CLAIM_TTL_HOURS. Run daily; exported for the
 * job and for tests.
 */
export async function expireStaleClaims({ query, now = new Date() }) {
  // No join on users: a holder whose account was deleted leaves claimed_by NULL (ON DELETE
  // SET NULL), and an inner join would keep that card claimed forever.
  const r = await query(
    `UPDATE tasks t SET status = 'open',
            body = t.body || $2 || COALESCE((SELECT name FROM users WHERE id = t.claimed_by), 'the holder') || $3,
            claimed_by = NULL, claimed_tool = NULL, claimed_session = NULL, claimed_at = NULL, updated_at = NOW()
      WHERE t.status = 'claimed'
        AND t.claimed_at < NOW() - INTERVAL '1 hour' * $1
      RETURNING t.id`,
    [CLAIM_TTL_HOURS, `\n\n[claim expired ${now.toISOString()}] `, ` did not finish within ${CLAIM_TTL_HOURS} hours; the card is open again.`],
  );
  return { expired: r.rows.map((x) => x.id) };
}
