import { Router } from 'express';
import { isValidTouch, OVERLAP_WINDOW_MINUTES } from '../../shared/touch-report.js';

/**
 * The collision warning's server half (v1.31.2).
 *
 * POST /         — the edit hook says "I am in this directory of this project"; the answer
 *                  is who else was there in the last two hours.
 * GET /overlaps  — admin+: pairs of members who were in the same place in the last day,
 *                  for the team stats page.
 *
 * A factory, like me-narrative.js and session-lessons.js, so a test can hand it a fake
 * `query` and prove the upsert, the window and the "not myself" rule without a database.
 */

const OVERLAPS_WINDOW_HOURS = 24;

export function createActivityTouchRouter({ query, auth, adminAuth, logger = console }) {
  const router = Router();

  router.post('/', auth, async (req, res) => {
    try {
      if (!isValidTouch(req.body)) {
        return res.status(400).json({ error: 'project and a project-relative dir are required' });
      }
      const { project, dir } = req.body;
      const sessionId = typeof req.body.session_id === 'string' && req.body.session_id
        ? req.body.session_id.slice(0, 100)
        : 'unknown';

      await query(
        `INSERT INTO edit_touches (user_id, project, dir, session_id, last_seen)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id, project, dir, session_id) DO UPDATE SET last_seen = NOW()`,
        [req.user.id, project, dir, sessionId],
      );

      // One row per other person, their most recent visit, inside the window. A person's
      // own second session is not a collision.
      const others = await query(
        `SELECT u.name,
                ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(t.last_seen))) / 60)::int AS minutes_ago
           FROM edit_touches t
           JOIN users u ON u.id = t.user_id
          WHERE t.project = $1 AND t.dir = $2 AND t.user_id <> $3
            AND t.last_seen >= NOW() - INTERVAL '1 minute' * $4
          GROUP BY u.id, u.name
          ORDER BY MAX(t.last_seen) DESC
          LIMIT 10`,
        [project, dir, req.user.id, OVERLAP_WINDOW_MINUTES],
      );
      res.json({
        others: others.rows.map((r) => ({ name: r.name || 'a colleague', minutes_ago: Number(r.minutes_ago) || 0 })),
      });
    } catch (err) {
      logger.error('edit touch failed', { error: err.message });
      res.status(500).json({ error: 'Failed to record edit touch' });
    }
  });

  router.get('/overlaps', adminAuth, async (req, res) => {
    try {
      const result = await query(
        `SELECT a.project, a.dir,
                ua.name AS first_name, ub.name AS second_name,
                GREATEST(MAX(a.last_seen), MAX(b.last_seen)) AS last_seen
           FROM edit_touches a
           JOIN edit_touches b
             ON a.project = b.project AND a.dir = b.dir AND a.user_id < b.user_id
           JOIN users ua ON ua.id = a.user_id
           JOIN users ub ON ub.id = b.user_id
          WHERE a.last_seen >= NOW() - INTERVAL '1 hour' * $1
            AND b.last_seen >= NOW() - INTERVAL '1 hour' * $1
          GROUP BY a.project, a.dir, ua.id, ub.id, ua.name, ub.name
          ORDER BY last_seen DESC
          LIMIT 100`,
        [OVERLAPS_WINDOW_HOURS],
      );
      res.json({ window_hours: OVERLAPS_WINDOW_HOURS, overlaps: result.rows });
    } catch (err) {
      logger.error('edit overlaps query failed', { error: err.message });
      res.status(500).json({ error: 'Query failed' });
    }
  });

  return router;
}
