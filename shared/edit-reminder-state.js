/**
 * v1.26.92 — throttle state for the edit-trigger iron rule reminder.
 *
 * Editing is the most frequent thing in a session, so the reminder cannot repeat its full
 * listing every time: a reminder that is in the way gets switched off, and a reminder that
 * is switched off enforces nothing. One full listing per hour, a single line for every
 * edit after that.
 *
 * State lives at `~/.ownmind/state/edit-reminder.json`, keyed by session:
 *   { sessions: { "<session_id>": { window_start_ms, occurrence, rule_count, window_ms? } } }
 *
 * Keyed by session because the audience is a session. The listing exists to put the rules
 * into one AI's context; a second session — or a subagent — that starts inside another
 * session's window would otherwise be told "68 rules, occurrence 2" and never be shown the
 * 68. A single shared window would also make two concurrent sessions take turns
 * invalidating each other, so each one gets its own.
 *
 * Fail-open, in the direction of showing too much rather than too little: a missing,
 * unreadable or malformed file reads as "no window open", so the worst outcome is one
 * extra full listing. The opposite default would silently suppress the reminder, which is
 * the failure this whole line of work exists to stop.
 *
 * The `rule_count` is carried here so the throttled path needs no network — without it,
 * every edit would put an HTTP round trip in front of the tool call just to learn a number
 * that has not changed.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const STATE_FILE = path.join(os.homedir(), '.ownmind', 'state', 'edit-reminder.json');

/** One hour, measured from the listing that opened the window — not a clock boundary. */
export const WINDOW_MS = 60 * 60 * 1000;

/**
 * How long to stay quiet after a failed lookup.
 *
 * Without a back-off, an unreachable server costs every single edit a 3s timeout for the
 * length of the outage, and prints nothing to explain it — a silent 3s tax on the most
 * frequent operation in the product. Five minutes is short enough that a brief outage does
 * not cost the user their hourly listing, and long enough that a long one is not felt.
 */
export const FETCH_BACKOFF_MS = 5 * 60 * 1000;

/** Sessions untouched for this long are dropped on the next write. */
const PRUNE_MS = 24 * 60 * 60 * 1000;

function getStatePath() {
  return process.env.__OWNMIND_EDIT_REMINDER_PATH || STATE_FILE;
}

function isEntry(e) {
  return e !== null && typeof e === 'object'
    && Number.isFinite(e.window_start_ms)
    && Number.isFinite(e.occurrence)
    && Number.isFinite(e.rule_count);
}

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(getStatePath(), 'utf8'));
    if (data === null || typeof data !== 'object') return {};
    if (data.sessions === null || typeof data.sessions !== 'object') return {};
    return data.sessions;
  } catch {
    return {};
  }
}

/**
 * @param {string} sessionId
 * @returns {{window_start_ms: number, occurrence: number, rule_count: number, window_ms?: number} | null}
 */
export function readEditReminderState(sessionId) {
  const entry = readStore()[sessionId || 'default'];
  return isEntry(entry) ? entry : null;
}

/**
 * @param {string} sessionId
 * @param {{window_start_ms: number, occurrence: number, rule_count: number, window_ms?: number}} entry
 * @returns {boolean} write success — callers must surface a failure rather than degrade quietly
 */
export function writeEditReminderState(sessionId, entry) {
  try {
    const p = getStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });

    const sessions = readStore();
    sessions[sessionId || 'default'] = entry;
    for (const [id, e] of Object.entries(sessions)) {
      if (!isEntry(e) || (entry.window_start_ms - e.window_start_ms) > PRUNE_MS) delete sessions[id];
    }

    // Write-then-rename: two sessions can edit at the same moment, and a torn file would
    // read as malformed. Last writer wins on the map itself, which at worst costs the
    // other session one extra listing.
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sessions }), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide what this edit should emit, given this session's stored entry.
 *
 * Pure: takes the clock as an argument so the window boundary is testable without waiting
 * an hour or stubbing Date.
 *
 * @param {{window_start_ms: number, occurrence: number, rule_count: number, counts?: object, window_ms?: number} | null} state
 * @param {number} nowMs
 * @returns {{mode: 'full' | 'line', occurrence: number, window_start_ms: number, rule_count: number, counts?: object}}
 */
export function decideEditReminder(state, nowMs) {
  // A failed lookup stores a short window instead of the usual hour, so the back-off is
  // data rather than a second code path.
  const windowMs = state && Number.isFinite(state.window_ms) && state.window_ms > 0
    ? state.window_ms
    : WINDOW_MS;

  const open = state !== null
    && nowMs >= state.window_start_ms
    && (nowMs - state.window_start_ms) < windowMs;

  if (!open) {
    return { mode: 'full', occurrence: 1, window_start_ms: nowMs, rule_count: 0 };
  }
  return {
    mode: 'line',
    occurrence: state.occurrence + 1,
    window_start_ms: state.window_start_ms,
    rule_count: state.rule_count,
    // issue #94 — the per-category counts ride along for the same reason rule_count does:
    // the throttled path must not make a request. `isEntry` does not require this field, so
    // a state file written before v1.26.151 still reads, and the caller falls back to the
    // single-count line when it is absent.
    counts: state.counts,
  };
}

/**
 * The throttled one-line reminder.
 *
 * The subject is the AI, deliberately. "63 rules in effect" reads as an instruction to
 * whoever is watching the screen, and they are not the party bound by them. It says the
 * rules apply — not that they were followed, which this hook cannot observe and which
 * would be a false claim exactly when it mattered.
 *
 * The occurrence number is there to answer the question the brevity provokes: a one-line
 * message where a list stood a minute ago looks like something broke.
 *
 * @param {string} version
 * @param {number} ruleCount
 * @param {number} occurrence
 */
export function renderEditReminderLine(version, ruleCount, occurrence) {
  return `【OwnMind v${version}】AI 改檔案要遵守的鐵律 ${ruleCount} 條 · 本小時第 ${occurrence} 次`;
}
