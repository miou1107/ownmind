import { Router } from 'express';
import { query as defaultQuery } from '../../utils/db.js';
import defaultAdminAuth from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';
import { isLower } from '../../utils/semver.js';
import { SERVER_VERSION } from '../../utils/server-version.js';

const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const STALE_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * GET /api/usage/admin/clients  (admin+)
 *
 * Response:
 * {
 *   server_version: '1.17.0',
 *   coverage: {
 *     total_users, installed, active, stale, offline, not_installed,
 *     needs_upgrade, on_old_host
 *   },
 *   users: [{
 *     user_id, user_name, email, role,
 *     any_active, needs_upgrade, installed,
 *     clients: [
 *       { tool, version, machine, last_heartbeat_at, status, needs_upgrade,
 *         api_host, on_old_host }
 *     ]
 *   }]
 * }
 *
 * Status categories (per-user overall):
 *   active         = any tool has a heartbeat within the last 24h
 *   stale          = newest heartbeat falls in 24–48h and is not refreshing
 *   offline        = newest heartbeat is older than 48h
 *   not_installed  = the user has never produced any heartbeat
 *
 * `needs_upgrade` rule (per-tool):
 *   if the client's scanner_version compares < SERVER_VERSION via semver → true.
 *   scanner_version null/'unknown' → treated as true (assume old version).
 *
 * Permission: admin+ (we do not leak other users' email to regular members).
 */
export function createAdminClientsRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const adminAuth = deps.adminAuth ?? defaultAdminAuth;
  const serverVersion = deps.serverVersion ?? SERVER_VERSION;
  const now = deps.now ?? (() => new Date());
  // v1.32.0 — read per request, not at import: the env is what production sets, and a
  // test that sets it after importing this module should still see it.
  const canonicalUrl = deps.canonicalUrl ?? (() => process.env.CANONICAL_URL || '');

  const router = Router();

  router.get('/', adminAuth, async (_req, res) => {
    try {
      const data = await loadClients({
        query, serverVersion, now: now(),
        canonicalHost: canonicalHostOf(typeof canonicalUrl === 'function' ? canonicalUrl() : canonicalUrl)
      });
      res.json(data);
    } catch (err) {
      logger.error('admin/clients query failed', { error: err.message });
      res.status(500).json({ error: 'Failed to query install status' });
    }
  });

  return router;
}

/**
 * v1.32.0 — the host of the server's own address, from CANONICAL_URL.
 *
 * Null when the variable is unset or not a URL, and then no client is ever flagged: a
 * self-hosted install with no canonical address has no "old host" to be on.
 */
export function canonicalHostOf(canonicalUrl) {
  try {
    const host = new URL(String(canonicalUrl || '')).hostname;
    return host ? host.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function loadClients({ query, serverVersion, now, canonicalHost = null }) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);

  // Fetch all users and their per-(user, tool) heartbeats in one query.
  // collector_heartbeat already has UNIQUE (user_id, tool), so each pair has
  // a single row — a simple LEFT JOIN is enough.
  // (Removed DISTINCT ON and the unused heartbeat_status column, per codex review.)
  const result = await query(
    `SELECT u.id AS user_id, u.name AS user_name, u.email, u.role,
            h.tool, h.scanner_version, h.machine, h.os, h.last_reported_at, h.reason,
            h.api_host
       FROM users u
       LEFT JOIN collector_heartbeat h ON h.user_id = u.id
      ORDER BY u.id, h.tool NULLS LAST, h.machine NULLS LAST`
  );

  // Group by user_id.
  const byUser = new Map();
  for (const row of result.rows) {
    if (!byUser.has(row.user_id)) {
      byUser.set(row.user_id, {
        user_id: row.user_id,
        user_name: row.user_name,
        email: row.email,
        role: row.role,
        clients: []
      });
    }
    // row.tool may be null (user with no heartbeat) — placeholder from LEFT JOIN.
    if (row.tool) {
      const lastAtMs = row.last_reported_at
        ? new Date(row.last_reported_at).getTime()
        : null;
      const age = lastAtMs != null ? nowMs - lastAtMs : null;
      const status = age == null
        ? 'unknown'
        : age <= ACTIVE_WINDOW_MS
          ? 'active'
          : age <= STALE_WINDOW_MS
            ? 'stale'
            : 'offline';
      const version = row.scanner_version || null;
      const needsUpgrade = !version || version === 'unknown'
        ? true
        : isLower(version, serverVersion);

      byUser.get(row.user_id).clients.push({
        tool: row.tool,
        version,
        machine: row.machine,
        // v1.26.73 — the console groups by computer now, and "TANK" alone does not say
        // which kind of computer it is. One row per (tool, machine) makes that worth
        // showing; before, every row was the same machine anyway.
        os: row.os ?? null,
        last_heartbeat_at: row.last_reported_at,
        status,
        // v1.26.69 — `status` above is derived from heartbeat age and answers "is this
        // collector talking". `reason` comes from the collector itself and answers
        // "why did it have nothing to say". Null for anything older than v1.26.69.
        reason: row.reason ?? null,
        needs_upgrade: needsUpgrade,
        // v1.32.0 — which server this machine posts to, as the scanner reported it. Null
        // for a scanner older than v1.32.0. `on_old_host` is the thing to act on: the
        // host is known and it is not this server's own (issue #152).
        api_host: row.api_host ?? null,
        on_old_host: Boolean(canonicalHost && row.api_host && row.api_host !== canonicalHost)
      });
    }
  }

  const users = Array.from(byUser.values()).map((u) => {
    const installed = u.clients.length > 0;
    const anyActive = u.clients.some((c) => c.status === 'active');
    const needsUpgrade = u.clients.some((c) => c.needs_upgrade);
    const onOldHost = u.clients.some((c) => c.on_old_host);
    return { ...u, installed, any_active: anyActive, needs_upgrade: needsUpgrade, on_old_host: onOldHost };
  });

  // Coverage summary.
  const coverage = {
    total_users: users.length,
    installed: users.filter((u) => u.installed).length,
    active: users.filter((u) => u.any_active).length,
    stale: users.filter((u) =>
      u.installed && !u.any_active
        && u.clients.some((c) => c.status === 'stale')
    ).length,
    offline: users.filter((u) =>
      u.installed && !u.any_active
        && u.clients.every((c) => c.status === 'offline' || c.status === 'unknown')
    ).length,
    not_installed: users.filter((u) => !u.installed).length,
    needs_upgrade: users.filter((u) => u.installed && u.needs_upgrade).length,
    on_old_host: users.filter((u) => u.on_old_host).length
  };

  // Sort: needs_upgrade first, then uninstalled last, otherwise by id.
  users.sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    if (a.needs_upgrade !== b.needs_upgrade) return a.needs_upgrade ? -1 : 1;
    return a.user_id - b.user_id;
  });

  return {
    server_version: serverVersion,
    coverage,
    users
  };
}

export default createAdminClientsRouter();
