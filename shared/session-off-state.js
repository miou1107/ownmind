/**
 * v1.20.3: Session temporary-off switch — state file read/write.
 *
 * Purpose:
 *   The user can temporarily disable OwnMind hooks (lint + pre-commit) in the
 *   current session via /ownmind-off. State is stored at
 *   `~/.ownmind/state/session-off.json`:
 *     { session_id, off_at (ISO timestamp), tick_count }
 *
 * Cross-session expiry:
 *   - Stop hook: strictly matches session_id; clears the file on mismatch.
 *   - Pre-commit hook: cannot see session_id, only checks whether off_at is
 *     within 24 hours; clears the file on expiry.
 *
 * Fail-open:
 *   - Parse failure / IO failure → treat as "not off" and run the hooks
 *     normally (do not treat write failures as "off").
 *   - Auto-create the directory if it does not exist.
 *
 * Pure-function design aside from the state-file IO; no other side effects,
 * zero external deps.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const STATE_DIR = path.join(os.homedir(), '.ownmind', 'state');
const STATE_FILE = path.join(STATE_DIR, 'session-off.json');
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

function getStatePath() {
  return process.env.__OWNMIND_SESSION_OFF_PATH || STATE_FILE;
}

/**
 * Read the state file. Returns null on failure or when the file is missing.
 * @returns {{session_id: string, off_at: string, tick_count: number} | null}
 */
export function readSessionOffState() {
  try {
    const p = getStatePath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return null;
    if (typeof data.session_id !== 'string') return null;
    if (typeof data.off_at !== 'string') return null;
    if (typeof data.tick_count !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Write the state file. Preserves tick_count when an existing record matches
 * session_id; otherwise initializes tick_count = 0.
 * @param {string} session_id
 * @returns {boolean} write success
 */
export function writeSessionOffState(session_id) {
  if (typeof session_id !== 'string' || !session_id) return false;
  try {
    const dir = path.dirname(getStatePath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = readSessionOffState();
    const tick_count = (existing && existing.session_id === session_id) ? existing.tick_count : 0;
    const data = {
      session_id,
      off_at: new Date().toISOString(),
      tick_count,
    };
    fs.writeFileSync(getStatePath(), JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear the state file (deletes it). A missing file is treated as success.
 * @returns {boolean}
 */
export function clearSessionOffState() {
  try {
    const p = getStatePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Increment tick_count and return the new value. Returns 0 with no effect
 * when the state file does not exist.
 * @returns {number} the new tick_count value
 */
export function incrementTickCount() {
  const state = readSessionOffState();
  if (!state) return 0;
  state.tick_count += 1;
  try {
    fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
    return state.tick_count;
  } catch {
    return state.tick_count;
  }
}

/**
 * Check whether OwnMind is in the off state — shared by the Stop hook and
 * the pre-commit hook.
 *
 * Logic: state file exists AND off_at is within 24 hours → considered off.
 *
 * Why no strict session_id comparison:
 *   - MCP tools write the state with sessionStartTime (MCP process start ts).
 *   - The Stop hook receives payload.session_id (the Claude session id).
 *   - These represent different things, so strict equality would always fail.
 *
 * New-session auto-clear is driven by SessionStart hook actively wiping the
 * state file (when a new conversation starts, SessionStart runs and removes
 * the stale state file).
 *
 * Auto-clear on expiry (safety net: avoids a stale state file activating N
 * days later).
 *
 * @returns {boolean}
 */
export function isOff() {
  const state = readSessionOffState();
  if (!state) return false;
  const offAtMs = Date.parse(state.off_at);
  if (Number.isNaN(offAtMs)) {
    clearSessionOffState();
    return false;
  }
  if (Date.now() - offAtMs > EXPIRY_MS) {
    clearSessionOffState();
    return false;
  }
  return true;
}
