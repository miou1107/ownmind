/**
 * v1.31.2 — what the edit hook remembers between edits about where it has been.
 *
 * Editing is the most frequent thing in a session. The collision check costs a network
 * round trip, so it is paid once per directory per ten minutes per session, and the answer
 * is reused in between. The pairs already printed are kept too, so the same colleague in
 * the same folder is mentioned once per session and not on every keystroke.
 *
 * State lives at `~/.ownmind/state/touches.json`:
 *   { sessions: { "<session_id>": { dirs: { "<project>/<dir>": { at_ms, others } },
 *                                    printed: ["<project>/<dir>|<name>"] } } }
 *
 * Fail-open in the direction of asking again: a missing or unreadable file reads as "never
 * reported", so the worst outcome is one extra request. Sessions untouched for a day are
 * dropped on write so the file does not grow with every conversation ever started.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { REPORT_WINDOW_MS } from '../../shared/touch-report.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function touchStateFile(home = os.homedir()) {
  return path.join(home, '.ownmind', 'state', 'touches.json');
}

export function readTouchState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') return parsed;
  } catch { /* fail open: no state is "never reported" */ }
  return { sessions: {} };
}

/** @returns {boolean} whether the write landed; the caller decides what to say if not. */
export function writeTouchState(file, state, nowMs) {
  try {
    const kept = {};
    for (const [sid, s] of Object.entries(state.sessions || {})) {
      const latest = Math.max(0, ...Object.values(s.dirs || {}).map((d) => Number(d?.at_ms) || 0));
      if (nowMs - latest < SESSION_TTL_MS) kept[sid] = s;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessions: kept }));
    return true;
  } catch {
    return false;
  }
}

export function touchKey(touch) {
  return `${touch.project}/${touch.dir}`;
}

/**
 * Whether this directory needs a fresh report, and if not, the answer last received.
 *
 * @returns {{ report: boolean, others: Array }}
 */
export function decideTouchReport(state, sessionId, key, nowMs) {
  const entry = state.sessions?.[sessionId]?.dirs?.[key];
  if (!entry || typeof entry.at_ms !== 'number' || nowMs - entry.at_ms >= REPORT_WINDOW_MS) {
    return { report: true, others: [] };
  }
  return { report: false, others: Array.isArray(entry.others) ? entry.others : [] };
}

export function recordTouchReport(state, sessionId, key, others, nowMs) {
  const s = state.sessions[sessionId] || (state.sessions[sessionId] = { dirs: {}, printed: [] });
  if (!s.dirs) s.dirs = {};
  if (!Array.isArray(s.printed)) s.printed = [];
  s.dirs[key] = { at_ms: nowMs, others: Array.isArray(others) ? others : [] };
  return state;
}

/**
 * The colleagues not yet mentioned for this directory in this session. Marks them as
 * mentioned on the way out, so the caller prints exactly what this returns.
 */
export function unprintedOthers(state, sessionId, key, others) {
  const s = state.sessions[sessionId] || (state.sessions[sessionId] = { dirs: {}, printed: [] });
  if (!Array.isArray(s.printed)) s.printed = [];
  const fresh = [];
  for (const o of others || []) {
    if (!o || typeof o.name !== 'string') continue;
    const tag = `${key}|${o.name}`;
    if (s.printed.includes(tag)) continue;
    s.printed.push(tag);
    fresh.push(o);
  }
  return fresh;
}
