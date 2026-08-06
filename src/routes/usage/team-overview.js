import { Router } from 'express';
import { query as defaultQuery } from '../../utils/db.js';
import defaultAdminAuth from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';

/**
 * Compute iron-rule compliance from a single session_logs.details.
 * Returns { complied, skipped, triggered }; triggered = complied + skipped.
 * When details is null or missing the relevant fields, all three are 0.
 */
export function extractRuleCounts(details) {
  if (!details || typeof details !== 'object') return { complied: 0, skipped: 0, triggered: 0 };
  const complied = Array.isArray(details.rules_complied) ? details.rules_complied.length : 0;
  const skipped = Array.isArray(details.rules_skipped) ? details.rules_skipped.length : 0;
  return { complied, skipped, triggered: complied + skipped };
}

/**
 * Sum the rule counts across multiple sessions; returns { complied, triggered, rate }.
 * When triggered === 0, rate is null (the front-end shows "—" and the row is
 * not ranked).
 */
export function aggregateCompliance(sessions) {
  let complied = 0, triggered = 0;
  for (const s of sessions) {
    const c = extractRuleCounts(s.details);
    complied += c.complied;
    triggered += c.triggered;
  }
  return {
    complied,
    triggered,
    rate: triggered === 0 ? null : complied / triggered
  };
}

/**
 * Pick the most common project (details.project) across multiple sessions.
 * Ties are broken alphabetically. If no session has a project → null.
 */
export function pickTopProject(sessions) {
  const counts = new Map();
  for (const s of sessions) {
    const p = s?.details?.project;
    if (typeof p !== 'string' || !p) continue;
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0], 'en');
  })[0][0];
}

export function createTeamOverviewRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const adminAuth = deps.adminAuth ?? defaultAdminAuth;
  const router = Router();
  // Additional routes will be added under Task 2.
  router.get('/', adminAuth, async (req, res) => {
    try {
      const to = req.query.to ? new Date(req.query.to) : new Date();
      const from = req.query.from
        ? new Date(req.query.from)
        : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return res.status(400).json({ error: 'from/to must be valid ISO dates' });
      }

      // v1.26.74 — 最近活動 used to be MAX(session_logs.created_at), and a session_log is
      // only written when the AI calls ownmind_log_session, which its own description says
      // happens "before a conversation ends". So one long working session showed the time
      // it *started* and did not move again until it finished. Raised from production on
      // 2026-08-06: the column read 00:20 while the person was working in Claude at 08:20.
      //
      // Three sources, three different delays, and the newest of them is the honest answer:
      //   session_logs  — lands when a conversation ends
      //   activity_logs — lands when the AI calls an ownmind tool, which a long coding
      //                   session may never do
      //   token_events  — lands on the scanner's schedule, and is the only one that moves
      //                   while somebody is in the middle of working
      //
      // Postgres GREATEST ignores NULLs and returns NULL only if every argument is, so a
      // member with no rows in one source simply does not contribute one.
      //
      // Membership of the list is deliberately still decided by session_logs. What the
      // timestamp means and who the page is about are separate questions; widening the
      // JOIN would quietly change the second one.
      const sql = `
        SELECT u.id AS user_id,
               u.name AS user_name,
               GREATEST(MAX(sl.created_at), act.last_ts, tok.last_ts) AS last_active_at,
               COUNT(sl.id)::int AS session_count,
               jsonb_agg(jsonb_build_object('details', sl.details)
                         ORDER BY sl.created_at DESC) AS sessions_json
          FROM users u
          JOIN session_logs sl ON sl.user_id = u.id
          LEFT JOIN LATERAL (
                 SELECT MAX(a.ts) AS last_ts
                   FROM activity_logs a
                  WHERE a.user_id = u.id AND a.ts >= $1 AND a.ts <= $2
               ) act ON TRUE
          LEFT JOIN LATERAL (
                 SELECT MAX(e.ts) AS last_ts
                   FROM token_events e
                  WHERE e.user_id = u.id AND e.ts >= $1 AND e.ts <= $2
               ) tok ON TRUE
         WHERE sl.created_at >= $1 AND sl.created_at <= $2
         GROUP BY u.id, u.name, act.last_ts, tok.last_ts
         ORDER BY GREATEST(MAX(sl.created_at), act.last_ts, tok.last_ts) DESC`;
      const result = await query(sql, [from.toISOString(), to.toISOString()]);

      const members = result.rows.map(row => {
        const sessions = Array.isArray(row.sessions_json) ? row.sessions_json : [];
        const compliance = aggregateCompliance(sessions);
        return {
          user_id: row.user_id,
          user_name: row.user_name,
          last_active_at: row.last_active_at,
          session_count: row.session_count,
          top_project: pickTopProject(sessions),
          rule_compliance: compliance.triggered === 0 ? null : compliance
        };
      });

      res.json({
        range: { from: from.toISOString(), to: to.toISOString() },
        members
      });
    } catch (err) {
      logger.error('team-overview query failed', { error: err.message });
      res.status(500).json({ error: 'Query failed' });
    }
  });

  router.get('/:user_id/sessions', adminAuth, async (req, res) => {
    try {
      const userId = parseInt(req.params.user_id, 10);
      if (!Number.isFinite(userId)) {
        return res.status(400).json({ error: 'user_id must be an integer' });
      }
      const to = req.query.to ? new Date(req.query.to) : new Date();
      const from = req.query.from
        ? new Date(req.query.from)
        : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return res.status(400).json({ error: 'from/to must be valid ISO dates' });
      }

      const rawLimit = parseInt(req.query.limit, 10);
      const limit = Math.min(Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 100, 500);

      const sql = `
        SELECT sl.id, sl.created_at, sl.tool, sl.model, sl.machine, sl.summary, sl.details,
               hb.os AS machine_os,
               hb.scanner_version AS machine_scanner_version
          FROM session_logs sl
     -- Note: collector_heartbeat's UNIQUE is (user_id, tool), so when a user
     -- moves between machines for the same tool only the newest one is kept.
     -- For older sessions across "the same user ran this tool on multiple
     -- machines", the fallback may miss (machine doesn't line up) → machine_meta
     -- becomes null and the front-end omits the side info. Transitional best-effort.
     -- Future: have the client push details.machine_meta directly, dropping
     -- the fallback entirely.
     LEFT JOIN LATERAL (
                 SELECT os, scanner_version
                   FROM collector_heartbeat h
                  WHERE h.user_id = sl.user_id AND h.machine = sl.machine
                  ORDER BY h.last_reported_at DESC
                  LIMIT 1
               ) hb ON TRUE
         WHERE sl.user_id = $1
           AND sl.created_at >= $2 AND sl.created_at <= $3
         ORDER BY sl.created_at DESC
         LIMIT $4`;
      const result = await query(sql, [userId, from.toISOString(), to.toISOString(), limit]);

      const sessions = result.rows.map(row => {
        const counts = extractRuleCounts(row.details);
        const meta = (row.machine_os || row.machine_scanner_version)
          ? { os: row.machine_os, scanner_version: row.machine_scanner_version }
          : null;
        return {
          id: row.id,
          created_at: row.created_at,
          tool: row.tool,
          model: row.model,
          machine: row.machine,
          machine_meta: meta,
          project: row.details?.project ?? null,
          duration_turns: row.details?.duration_turns ?? null,
          rule_compliance: counts.triggered === 0
            ? null
            : { complied: counts.complied, triggered: counts.triggered, rate: counts.complied / counts.triggered },
          summary: row.summary || '',
          details: row.details || {}
        };
      });

      res.json({ user_id: userId, range: { from: from.toISOString(), to: to.toISOString() }, sessions });
    } catch (err) {
      logger.error('team-overview sessions query failed', { error: err.message });
      res.status(500).json({ error: 'Query failed' });
    }
  });

  return router;
}

export default createTeamOverviewRouter();
