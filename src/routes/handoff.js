import { Router } from 'express';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';
import { requireFields } from '../utils/require-fields.js';
import { parseRowId } from '../utils/row-id.js';

const router = Router();

// Same guard as the memory router. No literal path is shadowed by `:id` here, so no real
// endpoint was answering 500 — but `PUT /api/handoff/abc/accept` still went to an INT
// column and came back as 500 "Failed to accept handoff", which says the server broke when
// what happened is that the caller sent something that is not an id.
router.param('id', (req, res, next, raw) => {
  if (!parseRowId(raw).ok) return res.status(404).json({ error: 'Handoff not found' });
  next();
});
router.use(auth);

/**
 * POST / - create a handoff.
 */
router.post('/', async (req, res) => {
  try {
    // v1.30.4: only project and content are required, matching what the tool declares and
    // what the columns allow. `from_tool` is defaulted by the MCP client from the tool
    // hosting it, and `from_model` is genuinely optional — nothing in the client knows it.
    // All four columns except content have been nullable since db/001_init.sql:76-87; this
    // makes the endpoint agree with its own schema. Same defect as member-6's bug #9.
    const validation = requireFields(req.body, ['project', 'content']);
    if (validation) return res.status(400).json(validation);

    const { project, from_tool, from_model, from_machine, content } = req.body;

    const result = await query(
      `INSERT INTO handoffs (user_id, project, from_tool, from_model, from_machine, content, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING *`,
      [req.user.id, project, from_tool, from_model, from_machine || null, content]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('handoff create failed', { error: err.message });
    res.status(500).json({ error: 'Failed to create handoff' });
  }
});

/**
 * GET /pending - fetch pending handoffs.
 *   ?with_accepted=7   v1.33.0: also the caller's accepted ones from the last N days (1–90),
 *                      for the console page that shows who took a handoff and offers 重開.
 *                      Without it the list stays pending-only; the session-start hook
 *                      relies on that.
 */
router.get('/pending', async (req, res) => {
  try {
    const days = Number.parseInt(req.query.with_accepted, 10);
    const withAccepted = Number.isInteger(days) && days > 0 ? Math.min(days, 90) : 0;
    const result = withAccepted
      ? await query(
        `SELECT * FROM handoffs
         WHERE user_id = $1
           AND (status = 'pending'
                OR (status = 'accepted' AND accepted_at >= NOW() - INTERVAL '1 day' * $2))
         ORDER BY created_at DESC`,
        [req.user.id, withAccepted]
      )
      : await query(
        `SELECT * FROM handoffs
         WHERE user_id = $1 AND status = 'pending'
         ORDER BY created_at DESC`,
        [req.user.id]
      );

    res.json(result.rows);
  } catch (err) {
    logger.error('pending handoff query failed', { error: err.message });
    res.status(500).json({ error: 'Query failed' });
  }
});

/**
 * PUT /:id/accept - accept a handoff.
 *
 * v1.33.0: only a pending one. Sessions accept on their own now, so two windows opened in
 * the same project a moment apart both call this; the second must not overwrite who took
 * it. It gets 409 with the row's status and taker, which the hook renders as "another
 * window took it n minutes ago".
 */
router.put('/:id/accept', async (req, res) => {
  try {
    const { accepted_by } = req.body;

    if (!accepted_by) {
      return res.status(400).json({ error: 'accepted_by is required' });
    }

    const result = await query(
      `UPDATE handoffs
       SET status = 'accepted',
           accepted_by = $1,
           accepted_at = NOW()
       WHERE id = $2 AND user_id = $3 AND status = 'pending'
       RETURNING *`,
      [accepted_by, req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      const existing = await query(
        'SELECT status, accepted_by, accepted_at FROM handoffs WHERE id = $1 AND user_id = $2',
        [req.params.id, req.user.id]
      );
      const row = existing.rows[0];
      if (!row) return res.status(404).json({ error: 'Handoff not found' });
      return res.status(409).json({
        error: 'Handoff already accepted',
        status: row.status,
        accepted_by: row.accepted_by,
        accepted_at: row.accepted_at,
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('handoff accept failed', { error: err.message });
    res.status(500).json({ error: 'Failed to accept handoff' });
  }
});

/**
 * PUT /:id/reopen - put an accepted handoff back to pending (v1.33.0).
 *
 * The next session in the matching project accepts a handoff on its own; this is the undo
 * when the wrong window took it. Only an accepted handoff of the caller's own reopens.
 */
router.put('/:id/reopen', async (req, res) => {
  try {
    const result = await query(
      `UPDATE handoffs
       SET status = 'pending', accepted_by = NULL, accepted_at = NULL
       WHERE id = $1 AND user_id = $2 AND status = 'accepted'
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Handoff not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('handoff reopen failed', { error: err.message });
    res.status(500).json({ error: 'Failed to reopen handoff' });
  }
});

export default router;
