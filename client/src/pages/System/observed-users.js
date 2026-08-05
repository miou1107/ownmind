// v1.26.50 — join /api/usage/admin/clients with /api/usage/team-stats to
// distinguish the state the old coverage metric hid.
//
// The old "已裝 / active" count read a heartbeat as installed, so a member
// whose collector connected but never produced a usage row read as "OK". This
// is the umbrella spec Requirement 7 hazard: the honest states are three,
// not one, and the operator needs the silent list by name to act on it.
//
// State vocabulary:
//   flowing        heartbeat + usage rows in the observation window
//   silent         heartbeat + zero usage rows (the hazard state)
//   not_installed  no heartbeat, ever
//   offline        heartbeat exists but every tool's status is 'offline' or
//                  'unknown' — the collector is not currently talking

/**
 * @param {object} clients  Body of /api/usage/admin/clients.
 * @param {object|null} stats  Body of /api/usage/team-stats, or null on
 *                             fetch failure. Null is treated as "no data
 *                             anywhere", so installed users read as silent
 *                             — a stats-fetch failure must never look like
 *                             everyone flowing.
 * @returns {Array<object>}   One row per user in the clients payload, with
 *                            .state and .usage attached.
 */
export function observedUsers(clients, stats) {
  const users = (clients && Array.isArray(clients.users)) ? clients.users : [];
  const statsById = new Map();
  const statsUsers = (stats && Array.isArray(stats.users)) ? stats.users : [];
  for (const s of statsUsers) {
    if (s && s.user && typeof s.user.id === 'number') {
      statsById.set(s.user.id, s.totals || {});
    }
  }

  return users.map((u) => {
    const state = classify(u, statsById.get(u.user_id));
    const usage = attachUsage(state, statsById.get(u.user_id));
    return { ...u, state, usage, reasons: collectReasons(u) };
  });
}

/**
 * v1.26.69 — what each collector said about why it had nothing.
 *
 * `silent` was the right diagnosis and the wrong stopping point: it says a person is
 * working and the numbers are not arriving, and leaves five possible causes for someone
 * to sort out by hand on that machine. The reason is an attribute of the state, not a
 * fifth state, so the four-way vocabulary above is untouched.
 *
 * A collector too old to send one contributes nothing here rather than a guess.
 */
function collectReasons(u) {
  const clients = Array.isArray(u.clients) ? u.clients : [];
  return clients
    .filter((c) => c && c.reason)
    .map((c) => ({ tool: c.tool, reason: c.reason }));
}

function classify(u, totals) {
  const installed = Boolean(u.installed);
  if (!installed) return 'not_installed';

  const active = Boolean(u.any_active);
  if (!active) return 'offline';

  const messages = totals ? Number(totals.message_count) || 0 : 0;
  const inputTokens = totals ? Number(totals.input_tokens) || 0 : 0;
  const outputTokens = totals ? Number(totals.output_tokens) || 0 : 0;
  const hasUsage = messages > 0 || inputTokens > 0 || outputTokens > 0;
  return hasUsage ? 'flowing' : 'silent';
}

function attachUsage(state, totals) {
  if (state !== 'flowing' || !totals) return { measured: false };
  const input = Number(totals.input_tokens) || 0;
  const output = Number(totals.output_tokens) || 0;
  return {
    measured: true,
    total_tokens: input + output,
    session_count: Number(totals.message_count) || 0,
  };
}

/**
 * Roll up per-user rows into the banner counts + silent-name list.
 *
 * @param {Array<object>} rows  Output of observedUsers().
 */
export function rollupCounts(rows) {
  const c = {
    total: rows.length,
    flowing: 0, silent: 0, not_installed: 0, offline: 0,
    silent_names: [],
  };
  for (const r of rows) {
    if (r.state === 'flowing') c.flowing++;
    else if (r.state === 'silent') {
      c.silent++;
      c.silent_names.push(r.user_name || `#${r.user_id}`);
    }
    else if (r.state === 'not_installed') c.not_installed++;
    else if (r.state === 'offline') c.offline++;
  }
  return c;
}
