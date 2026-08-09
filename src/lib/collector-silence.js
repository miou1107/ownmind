/**
 * collector-silence — decide which machines have a dead usage collector.
 *
 * Pure: no database, no clock, no logging. `now` arrives as an argument so the
 * thresholds can be asserted directly instead of inferred from a live table.
 *
 * ## What is being detected, and why it is not "no heartbeat for N days"
 *
 * Two different programs write `collector_heartbeat`, and they share rows:
 *
 *   - `mcp/index.js` beats for **one** tool (whichever IDE launched it) on every
 *     MCP start.
 *   - `hooks/ownmind-usage-scanner.js` beats for **all five** tools, from a
 *     schedule, and it is the only one that uploads usage.
 *
 * So when the schedule dies the person keeps heartbeating daily and keeps
 * uploading nothing. Measured on production 2026-08-07: one member's
 * `claude-code` row was 0.2 days old while her other three were 11.2 days old,
 * and her last actual usage event was 94 days ago. A "nobody has reported for N
 * days" rule scores that machine as healthy — it is the exact case that went
 * twenty days unnoticed and prompted this feature.
 *
 * The signal is therefore **disagreement inside one machine**: something beat
 * recently, something else stopped. On the same production snapshot all ten
 * healthy machines had every tool row written within the same second, so
 * freshest and stalest were identical; only the broken machine differed.
 *
 * ## What it deliberately does not detect
 *
 * A machine where *everything* went quiet. That is a computer that is switched
 * off, a person on leave, or a laptop that was replaced, far more often than it
 * is a fault, and there is nothing in this table that tells those apart. It is
 * recorded in openspec/BACKLOG.md rather than guessed at here.
 *
 * A machine where the scanner never ran once has no frozen row to notice, so it
 * is invisible here too; that is what the install self-check is for.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A row this recent proves something on the machine is still running.
 *
 * Two days rather than one: the scanner runs every two hours and the MCP beats
 * on IDE start, so a working machine is normally hours old, but a weekend day
 * with the laptop shut must not read as "alive" for a machine that is simply
 * off — nor as evidence of a fault.
 */
export const FRESH_DAYS = 2;

/**
 * A row this old is a collector that stopped, not one that is between runs.
 *
 * Seven days rather than three: on the production snapshot the longest silence
 * belonging to a healthy machine was 4.2 days (one person's whole computer, off
 * over a break). Seven clears that with room, and the machine that was genuinely
 * broken sat at 11.2.
 */
export const STALE_DAYS = 7;

/** Stable identity for one silence. JSON so no separator can collide with a value. */
export function stateKey(userId, machine) {
  return JSON.stringify([userId, machine]);
}

function ageDays(value, nowMs) {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return (nowMs - ms) / MS_PER_DAY;
}

/**
 * The stale-tool list as it is stored, so "same silence" compares equal across runs.
 * Sorted because the row order the database returns is not part of the finding.
 */
export function toolsFingerprint(tools) {
  return [...tools].sort().join(',');
}

/**
 * Report every machine that is currently broken, and every one that has stopped being.
 *
 * Deliberately **not** "which of these are new". That question is answered by the
 * claim statement in src/jobs/collector-silence-alerts.js, because it is also the
 * question two concurrent sweeps must not both answer yes to — and the only place
 * that can settle is the database. Answering it here as well would put the rule in
 * two places, and the copy in JavaScript would be the one with no locking.
 *
 * @param {{
 *   rows?: Array<{user_id: number, user_name?: string, machine: string, tool: string,
 *                 last_reported_at: Date|string}>,
 *   knownState?: Array<{user_id: number, machine: string, stale_tools: string,
 *                       announced_at: Date|null, resolved_at: Date|null,
 *                       broadcast_id: number|null}>,
 *   now?: Date,
 *   freshDays?: number,
 *   staleDays?: number,
 * }} input
 * @returns {{silences: Array<Object>, resolved: Array<Object>, cleared: Array<Object>}}
 *   `silences` — broken right now, whether or not anybody has been told.
 *   `resolved` — was announced, is now beating again; carries the broadcast to end.
 *   `cleared`  — was seen but never announced, and healed before it was confirmed.
 */
export function evaluateSilence({
  rows = [],
  knownState = [],
  now = new Date(),
  freshDays = FRESH_DAYS,
  staleDays = STALE_DAYS,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();

  const byKey = new Map(
    knownState.map((row) => [stateKey(row.user_id, row.machine), row])
  );

  /** @type {Map<string, {user_id: number, user_name: string, machine: string, tools: Array<{tool: string, age: number, at: Date}>}>} */
  const machines = new Map();

  for (const row of rows) {
    if (!row || typeof row.machine !== 'string' || !row.machine) continue;
    if (!Number.isInteger(row.user_id)) continue;
    const age = ageDays(row.last_reported_at, nowMs);
    // An unparseable timestamp is not a young one. Treating it as fresh would
    // vouch for a machine nothing has heard from; dropping the row leaves the
    // rest of the machine to be judged on rows that can be read.
    if (age === null) continue;

    const key = stateKey(row.user_id, row.machine);
    if (!machines.has(key)) {
      machines.set(key, {
        user_id: row.user_id,
        user_name: row.user_name || '',
        machine: row.machine,
        tools: [],
      });
    }
    machines.get(key).tools.push({
      tool: String(row.tool ?? ''),
      age,
      at: row.last_reported_at instanceof Date
        ? row.last_reported_at
        : new Date(row.last_reported_at),
    });
  }

  const silences = [];
  const resolved = [];
  const cleared = [];

  for (const [key, machine] of machines) {
    const prev = byKey.get(key);
    const freshest = Math.min(...machine.tools.map((t) => t.age));
    const stalest = Math.max(...machine.tools.map((t) => t.age));

    // Recovery first: every tool beating again closes an open finding, whatever
    // the thresholds would say about it now.
    if (stalest <= freshDays) {
      if (prev && prev.announced_at && !prev.resolved_at) {
        resolved.push({
          user_id: machine.user_id,
          machine: machine.machine,
          broadcast_id: prev.broadcast_id ?? null,
        });
      } else if (prev && !prev.announced_at) {
        // Seen once, healed before it was ever confirmed. The record has to go, or
        // its stale `first_seen_at` would let the next break skip the waiting
        // period this machine was never actually observed through.
        cleared.push({ user_id: machine.user_id, machine: machine.machine });
      }
      continue;
    }

    const alive = freshest <= freshDays;
    const stale = machine.tools.filter((t) => t.age >= staleDays);
    // Nothing alive, or nothing stopped: not the shape this detects. Say nothing
    // rather than guess — including about a machine that is entirely dark, which
    // is a switched-off computer far more often than it is a fault.
    if (!alive || stale.length === 0) continue;

    const staleTools = toolsFingerprint(stale.map((t) => t.tool));
    // The newest of the frozen rows: when the collector was last seen working.
    // Its age is what "已 N 天" means, so the two are taken from the same row —
    // pairing the newest timestamp with the oldest row's age would report a
    // silence longer than the one the date shows.
    const lastBeat = stale.reduce((newest, t) => (t.at > newest.at ? t : newest), stale[0]);

    silences.push({
      user_id: machine.user_id,
      user_name: machine.user_name,
      machine: machine.machine,
      stale_tools: staleTools,
      last_beat_at: lastBeat.at,
      // Rounded at the edge rather than inside the renderer, so every reader of
      // this finding sees the same number.
      stale_days: Math.floor(lastBeat.age),
    });
  }

  return { silences, resolved, cleared };
}

export default evaluateSilence;
