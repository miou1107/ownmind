import { Router } from 'express';
import { query as defaultQuery } from '../../utils/db.js';
import defaultAuth from '../../middleware/auth.js';
import logger from '../../utils/logger.js';
import { SERVER_VERSION } from '../../utils/server-version.js';

const EVENT_WINDOW_HOURS = 24;

/**
 * GET /api/usage/self-check
 *
 * What the server holds for **the calling account**, so a machine can check whether its
 * own data arrived instead of assuming a successful POST means it landed.
 *
 * ```
 * {
 *   server_version, server_time, user_id,
 *   tools: [{ tool, machine, os, scanner_version,
 *             last_reported_at, last_event_ts, reason, events_24h }]
 * }
 * ```
 *
 * **Permission: any authenticated user, own rows only.** A member runs this on their own
 * machine at the end of an upgrade, so it cannot be admin-gated — and that is exactly why
 * it takes no user parameter and every query filters on the session's `user_id`. There is
 * no path through this file that can name somebody else, and it never touches `users`.
 *
 * `server_time` is returned because the client must not measure heartbeat freshness with
 * its own clock. A machine whose clock is wrong would report a healthy collector as
 * broken, or a dead one as healthy, and it is precisely the machine nobody can go and ask.
 */
export function createSelfCheckRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const auth = deps.auth ?? defaultAuth;
  const serverVersion = deps.serverVersion ?? SERVER_VERSION;
  const now = deps.now ?? (() => new Date());

  const router = Router();

  router.get('/', auth, async (req, res) => {
    // Every member calls the identical url and is told apart by a header, so a shared
    // cache keyed on the url would serve one person's machine names and counts to the
    // next. helmet sets no Cache-Control of its own; that was checked, not assumed.
    res.set('Cache-Control', 'no-store, private');

    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });

    try {
      const [beats, counts, memory] = await Promise.all([
        query(
          `SELECT tool, machine, os, scanner_version,
                  last_reported_at, last_event_ts, reason
             FROM collector_heartbeat
            WHERE user_id = $1
            ORDER BY tool, machine`,
          [userId]
        ),
        query(
          `SELECT tool, COUNT(*)::bigint AS events_24h
             FROM token_events
            WHERE user_id = $1
              AND ts >= NOW() - INTERVAL '${EVENT_WINDOW_HOURS} hours'
            GROUP BY tool`,
          [userId]
        ),
        // v1.26.81 — whether this account's memories and iron rules ever loaded
        // automatically. Nothing asked this before, which is how six machines went three
        // months without it working and without anyone noticing.
        //
        // `source` matters more than the count. The hook is the automatic path; the MCP's
        // own init only fires when the AI decides to call the tool. Collapsing them would
        // report a machine as healthy on the strength of the AI having remembered.
        query(
          `SELECT MAX(ts) FILTER (WHERE source = 'hook') AS last_hook_init_at,
                  MAX(ts) FILTER (WHERE source = 'mcp')  AS last_mcp_init_at,
                  COUNT(*) FILTER (
                    WHERE source = 'hook' AND ts >= NOW() - INTERVAL '7 days'
                  )::bigint AS hook_inits_7d
             FROM activity_logs
            WHERE user_id = $1 AND event = 'init'`,
          [userId]
        )
      ]);

      const recent = new Map(
        (counts.rows ?? []).map((r) => [r.tool, Number(r.events_24h) || 0])
      );

      const mem = memory.rows?.[0] ?? {};

      res.json({
        server_version: serverVersion,
        server_time: now().toISOString(),
        user_id: userId,
        // Always present, null when it never happened. An absent field reads as "the
        // server is too old to answer" and a defensive caller would treat it as unknown;
        // null is the finding.
        memory_load: {
          last_hook_init_at: toIso(mem.last_hook_init_at ?? null),
          last_mcp_init_at: toIso(mem.last_mcp_init_at ?? null),
          hook_inits_7d: Number(mem.hook_inits_7d ?? 0)
        },
        tools: (beats.rows ?? []).map((r) => ({
          tool: r.tool,
          machine: r.machine ?? null,
          os: r.os ?? null,
          scanner_version: r.scanner_version ?? null,
          last_reported_at: toIso(r.last_reported_at),
          last_event_ts: toIso(r.last_event_ts),
          reason: r.reason ?? null,
          // Zero rather than absent. "Heartbeat arrives, no events" is the hazard state
          // this endpoint exists to expose; dropping the row would hide it.
          events_24h: recent.get(r.tool) ?? 0
        }))
      });
    } catch (err) {
      // The message can carry a database host and port. The caller is any signed-in
      // member, so it stays in the log.
      logger.error('self-check query failed', { error: err.message, userId });
      res.status(500).json({ error: 'Failed to read collector status' });
    }
  });

  return router;
}

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

export default createSelfCheckRouter();
