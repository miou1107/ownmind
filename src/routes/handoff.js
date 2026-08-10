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
    const validation = requireFields(req.body, ['project', 'from_tool', 'from_model', 'content']);
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
 */
router.get('/pending', async (req, res) => {
  try {
    const result = await query(
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
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [accepted_by, req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Handoff not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('handoff accept failed', { error: err.message });
    res.status(500).json({ error: 'Failed to accept handoff' });
  }
});

export default router;
