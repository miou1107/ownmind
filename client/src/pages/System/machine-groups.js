/**
 * client/src/pages/System/machine-groups.js
 *
 * v1.26.73 — `collector_heartbeat` holds one row per (user, tool, machine), so the tools
 * column can show the same tool twice for one person. Two rows reading `claude-code` with
 * different versions and no way to tell which computer each came from is worse than the
 * single row it replaced.
 *
 * The panel groups by machine instead: the computer is the thing a person acts on, and
 * "TANK has not reported for three days" is the sentence somebody can do something about.
 *
 * Pure, so the grouping is testable without rendering anything.
 */

/** Ordered worst-first, because a person scanning the column is looking for trouble. */
const STATUS_RANK = { offline: 0, stale: 1, unknown: 2, active: 3 };

/**
 * Group a user's collector rows by the computer they came from.
 *
 * @param {Array} clients  from /api/usage/admin/clients — { tool, version, machine, os,
 *                         status, last_heartbeat_at, needs_upgrade, reason }
 * @returns {Array} [{ machine, os, status, last_heartbeat_at, needs_upgrade, tools[] }]
 *                  worst status first, then oldest heartbeat first
 */
export function groupClientsByMachine(clients) {
  const list = Array.isArray(clients) ? clients : [];
  const byMachine = new Map();

  for (const c of list) {
    if (!c) continue;
    // A row with no machine still has to appear. Its own status is the point; hiding it
    // because the name is missing would lose exactly the collectors worth looking at.
    const key = c.machine ?? '';
    if (!byMachine.has(key)) {
      byMachine.set(key, {
        machine: c.machine ?? null,
        os: c.os ?? null,
        status: c.status ?? 'unknown',
        last_heartbeat_at: c.last_heartbeat_at ?? null,
        needs_upgrade: false,
        tools: []
      });
    }
    const g = byMachine.get(key);
    g.tools.push({
      tool: c.tool,
      version: c.version ?? null,
      status: c.status ?? 'unknown',
      needs_upgrade: Boolean(c.needs_upgrade),
      reason: c.reason ?? null,
      last_heartbeat_at: c.last_heartbeat_at ?? null
    });

    if (c.os && !g.os) g.os = c.os;
    if (c.needs_upgrade) g.needs_upgrade = true;
    // The machine's status is its worst tool's. One dead collector on an otherwise busy
    // computer is the case this whole change exists to make visible; averaging it away
    // would put it straight back.
    if (rank(c.status) < rank(g.status)) g.status = c.status ?? 'unknown';
    // And its heartbeat is the freshest, because that is when the computer last spoke.
    if (newer(c.last_heartbeat_at, g.last_heartbeat_at)) {
      g.last_heartbeat_at = c.last_heartbeat_at;
    }
  }

  const groups = [...byMachine.values()];
  for (const g of groups) g.tools.sort((a, b) => String(a.tool).localeCompare(String(b.tool)));

  return groups.sort((a, b) => {
    const byStatus = rank(a.status) - rank(b.status);
    if (byStatus !== 0) return byStatus;
    const at = time(a.last_heartbeat_at);
    const bt = time(b.last_heartbeat_at);
    if (at !== bt) return at - bt;          // oldest first within the same status
    return String(a.machine ?? '').localeCompare(String(b.machine ?? ''));
  });
}

function rank(status) {
  return STATUS_RANK[status] ?? STATUS_RANK.unknown;
}

function time(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;   // unknown sorts alongside the oldest
}

function newer(candidate, held) {
  if (!candidate) return false;
  if (!held) return true;
  return time(candidate) > time(held);
}

/** macOS / Windows / Linux, from what Node reported. */
export function osLabel(os) {
  switch (os) {
    case 'darwin': return 'macOS';
    case 'win32': return 'Windows';
    case 'linux': return 'Linux';
    default: return os || null;
  }
}
