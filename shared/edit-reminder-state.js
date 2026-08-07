/**
 * v1.26.92 — throttle state for the edit-trigger iron rule reminder.
 *
 * Editing is the most frequent thing in a session, so the reminder cannot repeat its full
 * listing every time: a reminder that is in the way gets switched off, and a reminder that
 * is switched off enforces nothing. One full listing per hour, a single line for every
 * edit after that.
 *
 * State lives at `~/.ownmind/state/edit-reminder.json`:
 *   { window_start_ms, occurrence, rule_count }
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

function getStatePath() {
  return process.env.__OWNMIND_EDIT_REMINDER_PATH || STATE_FILE;
}

/**
 * @returns {{window_start_ms: number, occurrence: number, rule_count: number} | null}
 */
export function readEditReminderState() {
  try {
    const raw = fs.readFileSync(getStatePath(), 'utf8');
    const data = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return null;
    if (typeof data.window_start_ms !== 'number' || !Number.isFinite(data.window_start_ms)) return null;
    if (typeof data.occurrence !== 'number' || !Number.isFinite(data.occurrence)) return null;
    if (typeof data.rule_count !== 'number' || !Number.isFinite(data.rule_count)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * @param {{window_start_ms: number, occurrence: number, rule_count: number}} state
 * @returns {boolean} write success
 */
export function writeEditReminderState(state) {
  try {
    const p = getStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Write-then-rename: two sessions can edit at the same moment, and a torn file would
    // read as malformed — recoverable, but it would cost a spurious full listing.
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide what this edit should emit, given the stored state.
 *
 * Pure: takes the clock as an argument so the window boundary is testable without waiting
 * an hour or stubbing Date.
 *
 * @param {{window_start_ms: number, occurrence: number, rule_count: number} | null} state
 * @param {number} nowMs
 * @returns {{mode: 'full' | 'line', occurrence: number, window_start_ms: number, rule_count: number}}
 */
export function decideEditReminder(state, nowMs) {
  const open = state !== null && (nowMs - state.window_start_ms) < WINDOW_MS
    && nowMs >= state.window_start_ms;

  if (!open) {
    return { mode: 'full', occurrence: 1, window_start_ms: nowMs, rule_count: 0 };
  }
  return {
    mode: 'line',
    occurrence: state.occurrence + 1,
    window_start_ms: state.window_start_ms,
    rule_count: state.rule_count,
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
