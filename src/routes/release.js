import { Router } from 'express';
import { normalizeLinks } from '../../shared/task-body.js';

/**
 * The OwnMind half of the release check (v1.31.5).
 *
 *   GET  /check?project=&milestone=&since=   cards of the milestone (or of the project) that
 *                                            are / are not reviewed; this person's lessons from
 *                                            the project since `since` still `new`; every
 *                                            active team standard tagged for a release, in full
 *   POST /tag { project, milestone?, tag }   write links.released_in on every reviewed card of
 *                                            the milestone; refused while one is not reviewed
 *
 * A factory, like the other v1.31 routers, so it is proved against a fake query.
 */

const RELEASE_TAGS = ['trigger:deploy', 'trigger:release', 'deploy', 'release'];

function milestoneWhere(slot) {
  return `(t.links->>'milestone' = ${slot})`;
}

export function createReleaseRouter({ query, auth, logger = console }) {
  const router = Router();
  router.use(auth);

  router.get('/check', async (req, res) => {
    try {
      const project = typeof req.query.project === 'string' ? req.query.project.trim().slice(0, 255) : '';
      const milestone = typeof req.query.milestone === 'string' ? req.query.milestone.trim().slice(0, 255) : '';
      const since = typeof req.query.since === 'string' && !Number.isNaN(Date.parse(req.query.since)) ? req.query.since : null;
      if (!project) return res.status(400).json({ error: 'project is required' });

      let cards = { pending: [], ready: [] };
      try {
        const values = [project, req.user.id];
        let where = `t.project = $1 AND (t.is_private = FALSE OR t.user_id = $2 OR t.claimed_by = $2) AND t.status <> 'dropped'`;
        if (milestone) { values.push(milestone); where += ` AND ${milestoneWhere(`$${values.length}`)}`; }
        else where += ` AND t.status <> 'reviewed'`;
        const r = await query(
          `SELECT t.id, t.title, t.status, holder.name AS holder
             FROM tasks t LEFT JOIN users holder ON holder.id = t.claimed_by
            WHERE ${where}
            ORDER BY t.created_at ASC LIMIT 200`,
          values,
        );
        for (const row of r.rows) (row.status === 'reviewed' ? cards.ready : cards.pending).push(row);
      } catch (err) {
        logger.warn('release check: cards unavailable', { error: err.message });
        cards = { pending: [], ready: [], unavailable: true };
      }

      let lessons = null;
      try {
        const values = [req.user.id, project];
        let where = `user_id = $1 AND project = $2 AND status = 'new'`;
        if (since) { values.push(since); where += ` AND created_at >= $${values.length}`; }
        const r = await query(`SELECT COUNT(*)::int AS n FROM session_lessons WHERE ${where}`, values);
        lessons = { new: r.rows[0]?.n ?? 0 };
      } catch (err) {
        logger.warn('release check: lessons unavailable', { error: err.message });
      }

      let standards = [];
      try {
        const r = await query(
          `SELECT id, title, content, tags FROM memories
            WHERE type = 'team_standard' AND status = 'active' AND tags && $1::text[]
            ORDER BY title ASC LIMIT 50`,
          [RELEASE_TAGS],
        );
        standards = r.rows;
      } catch (err) {
        logger.warn('release check: standards unavailable', { error: err.message });
      }

      res.json({ project, milestone: milestone || null, since, cards, lessons, standards });
    } catch (err) {
      logger.error('release check failed', { error: err.message });
      res.status(500).json({ error: 'OwnMind could not run the release check; try again in a moment' });
    }
  });

  router.post('/tag', async (req, res) => {
    try {
      const project = typeof req.body?.project === 'string' ? req.body.project.trim().slice(0, 255) : '';
      const milestone = typeof req.body?.milestone === 'string' ? req.body.milestone.trim().slice(0, 255) : '';
      const tag = typeof req.body?.tag === 'string' ? req.body.tag.trim().slice(0, 100) : '';
      if (!project || !tag) return res.status(400).json({ error: 'project and tag are required' });

      // The same visibility as GET /check: a tag is recorded only on cards this person may
      // see, and a 409 never lists another member's private card.
      const values = [project, req.user.id];
      let where = `t.project = $1 AND t.status NOT IN ('dropped') AND (t.is_private = FALSE OR t.user_id = $2 OR t.claimed_by = $2)`;
      if (milestone) { values.push(milestone); where += ` AND ${milestoneWhere(`$${values.length}`)}`; }
      const open = await query(
        `SELECT t.id, t.status FROM tasks t WHERE ${where} AND t.status <> 'reviewed' ORDER BY t.id`,
        values,
      );
      if (open.rows.length > 0) {
        return res.status(409).json({ error: 'Not every card is reviewed', cards: open.rows });
      }
      const links = JSON.stringify(normalizeLinks({ released_in: tag }));
      values.push(links);
      const updated = await query(
        `UPDATE tasks t SET links = t.links || $${values.length}::jsonb, updated_at = NOW()
          WHERE ${where} AND t.status = 'reviewed'
          RETURNING t.id`,
        values,
      );
      res.json({ tag, cards: updated.rows.map((r) => r.id) });
    } catch (err) {
      logger.error('release tag failed', { error: err.message });
      res.status(500).json({ error: 'OwnMind could not record the tag; try again in a moment' });
    }
  });

  return router;
}
