import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Throttling for the recurring "this turn was NOT checked" notices.
 *
 * The product owner's call (2026-08-14): announce every state CHANGE — including recovery —
 * and while the same state persists, repeat every REPEAT_EVERY turns. The alternative was a
 * line under every reply for the whole length of an outage, and the rational user response
 * to that is switching the product off, which is a worse failure than the outage.
 *
 * Event-shaped notices (a violation pushed back, the retry cap reached, the lint banner)
 * never pass through here: each of those is news, not a state.
 */

const REPEAT_EVERY = 10;

let statePath = path.join(os.homedir(), '.ownmind', 'state', 'notice-throttle.json');

/** For tests only: override the state file, or pass null to restore the default. */
export function _statePathForTests(p) {
  statePath = p || path.join(os.homedir(), '.ownmind', 'state', 'notice-throttle.json');
}

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Missing or corrupt reads as fresh: the worst outcome is one extra announcement,
    // which is the safe direction for a channel whose failure mode was silence.
    return {};
  }
}

function writeAll(data) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(data));
  } catch { /* a throttle that cannot persist over-speaks; it never under-speaks */ }
}

/**
 * Should this turn's state be spoken?
 *
 * @param {string} sessionId
 * @param {string|null} noticeKey identity of the current not-checked state
 *   (e.g. 'not-checked:backoff'), or null for a healthy checked turn
 * @returns {boolean} true → emit the notice (for null: emit the all-clear)
 */
export function decideNotice(sessionId, noticeKey) {
  const sid = (typeof sessionId === 'string' && sessionId) || 'unknown';
  const all = readAll();
  const prev = all[sid] || { key: null, turnsInState: 0 };

  if (noticeKey === prev.key) {
    if (noticeKey === null) return false;
    const turns = prev.turnsInState + 1;
    all[sid] = { key: noticeKey, turnsInState: turns };
    writeAll(all);
    return turns % REPEAT_EVERY === 0;
  }

  // State changed. Recovery (→ null) is announced once; a new degraded state immediately.
  const wasDegraded = prev.key !== null;
  all[sid] = { key: noticeKey, turnsInState: 1 };
  writeAll(all);
  return noticeKey !== null ? true : wasDegraded;
}
