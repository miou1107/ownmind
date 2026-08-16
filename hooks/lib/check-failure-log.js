import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Why a reply check did not run — the local record, v1.30.2.
 *
 * The user-facing notice deliberately carries no error text: `timeout`, `http 401` and
 * `unknown` are the internal vocabulary the message rules ban, and an earlier version that
 * spliced the reason into the sentence is what those rules were written against. Removing it
 * left the reason with no sink at all, so a revoked key and a two-second blip both read as
 * "OwnMind could not reach its server", every tenth turn, with nothing on the machine that
 * could tell them apart.
 *
 * So the detail comes here instead, where a person or an assistant diagnosing the machine can
 * read it, and the sentence the user reads stays in their language.
 *
 * This is a diagnosis, not enforcement: it is written locally and never uploaded, because the
 * failure it most needs to record is precisely the one where the server cannot be reached.
 */

const DEFAULT_PATH = path.join(os.homedir(), '.ownmind', 'logs', 'check-failures.jsonl');

/**
 * One megabyte before rotating, so the ceiling on disk is two: this file plus one `.old`.
 * Small either way — it holds one line per failed turn, and only failed turns.
 */
export const MAX_LOG_BYTES = 1024 * 1024;

let logPath = DEFAULT_PATH;

/** For tests only: override the log file, or pass null to restore the default. */
export function _logPathForTests(p) {
  logPath = p || DEFAULT_PATH;
}

/**
 * Append one failed check.
 *
 * Every occurrence is kept rather than deduplicated: the questions this file exists to answer
 * are "when did this start" and "is it still happening", and both need the repeats.
 *
 * @param {object} entry
 * @param {string} [entry.sessionId]
 * @param {string} [entry.failure] one of the classifications from verdict-collect.js
 * @param {string} [entry.reason] the detail behind it, already redacted by the client
 * @param {number|null} [entry.checkId] present when the server got far enough to record a row
 *   of its own — that row holds the real cause, and this is the only thing that can join a
 *   line here to it
 * @returns {boolean} true when written; false on any failure. Never throws — the caller is a
 *   hook on the critical path of every reply.
 */
export function logCheckFailure(entry) {
  const record = {
    ts: new Date().toISOString(),
    session_id: (entry && typeof entry.sessionId === 'string' && entry.sessionId) || 'unknown',
    failure: (entry && typeof entry.failure === 'string' && entry.failure) || 'unknown',
    reason: (entry && typeof entry.reason === 'string' && entry.reason) || 'unknown',
    // Coerced rather than type-checked. `compliance_checks.id` is SERIAL today and node-pg
    // hands int4 back as a number, but the day it becomes BIGSERIAL that same driver returns a
    // string, and a `Number.isFinite` guard would start silently writing null — losing the one
    // field that joins this line to the server's own record, with no test going red.
    check_id: Number.isFinite(Number(entry?.checkId)) && entry?.checkId !== null
      && entry?.checkId !== undefined && entry?.checkId !== ''
      ? Number(entry.checkId)
      : null,
  };

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    try {
      if (fs.statSync(logPath).size > MAX_LOG_BYTES) {
        fs.renameSync(logPath, `${logPath}.old`);
      }
    } catch { /* no file yet, or a rename we could not do: appending is still correct */ }
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}
