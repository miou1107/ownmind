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
 * The key one window is stored under.
 *
 * v1.26.154 — the trigger joins the session in the key, so commit, deploy, delete, install and
 * edit each get their own hour. They have to: the listing names the memories that matched
 * *this* operation, and the four that match a commit are not the four that match a deploy.
 * Sharing one window meant seeing the commit list at 10:00 and being told, silently, that the
 * deploy list at 10:20 had already been shown. It had not.
 *
 * Entries written before this release are keyed by the bare session id, so they no longer
 * match and the first operation of each kind prints one extra listing. That is the safe
 * direction, and `PRUNE_MS` clears them within a day.
 */
export function windowKey(sessionId, trigger) {
  return `${sessionId || 'default'}::${trigger || 'edit'}`;
}

/**
 * @param {string} sessionId
 * @param {string} [trigger]
 * @returns {{window_start_ms: number, occurrence: number, rule_count: number, window_ms?: number} | null}
 */
export function readEditReminderState(sessionId, trigger) {
  const entry = readStore()[windowKey(sessionId, trigger)];
  return isEntry(entry) ? entry : null;
}

/**
 * @param {string} sessionId
 * @param {{window_start_ms: number, occurrence: number, rule_count: number, window_ms?: number}} entry
 * @returns {boolean} write success — callers must surface a failure rather than degrade quietly
 */
export function writeEditReminderState(sessionId, trigger, entry) {
  try {
    const p = getStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });

    const sessions = readStore();
    sessions[windowKey(sessionId, trigger)] = entry;
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
    // v1.26.154 — the denominators, carried for the same reason and on the same terms. The
    // names deliberately do not ride along: they are what the window exists to withhold, and
    // storing them would put the wall of text one bug away from coming back.
    totals: state.totals,
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
  // v1.26.161 — English at the source, like every other string a hook emits. This one is glued
  // onto a line the model is explicitly told to translate, so half of it arriving pre-translated
  // into one particular language was the line contradicting its own instruction.
  // "the AI must follow" is load-bearing and predates the translation: without it the line reads
  // as an instruction to whoever is watching the screen, and they are not the party bound.
  return `[OwnMind v${version}] This operation is a "File edit" procedure. `
    + `Iron rules the AI must follow: ${ruleCount} · occurrence ${occurrence} this hour`;
}
