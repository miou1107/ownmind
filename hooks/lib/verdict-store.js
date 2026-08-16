/**
 * Where a verdict waits between the turn that produced it and the turn that reads it.
 *
 * The judge now runs on the user's own subscription, which takes 29–54 seconds — measured,
 * real CLI, real payload. Nobody waits that long after every reply, so the Stop hook starts
 * the judge and returns, and the next `UserPromptSubmit` picks up whatever has landed. This
 * file is the handover.
 *
 * TWO PROCESSES, NO LOCK. The writer is a detached judge that outlived the hook that spawned
 * it; the reader is the next turn's hook. They are not coordinated and they can overlap, so
 * the write is a write-then-rename: a reader either sees the previous state or the complete
 * new one, never half a JSON document. `fs.rename` over an existing path is atomic on POSIX
 * and on NTFS, which is every platform this ships to.
 *
 * READING IS TAKING. A verdict is delivered once. Leaving it in place would re-report the
 * same violation on every subsequent turn, which trains the reader to ignore it — the failure
 * mode the throttling elsewhere in this product exists to prevent.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Same shape the gate uses; anything outside it could steer a path out of the state dir. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

export function stateDir() {
  return process.env.OWNMIND_STATE_DIR || path.join(os.homedir(), '.ownmind', 'state');
}

const safeSid = (sessionId) => (
  typeof sessionId === 'string' && SAFE_SESSION_ID.test(sessionId) ? sessionId : 'unknown'
);

export function verdictPath(sessionId, dir = stateDir()) {
  return path.join(dir, `reply-verdict-${safeSid(sessionId)}.json`);
}

export function jobPath(sessionId, dir = stateDir()) {
  return path.join(dir, `judge-job-${safeSid(sessionId)}.json`);
}

/**
 * Put a verdict where the next turn will find it.
 *
 * @returns {boolean} true when it landed. False rather than a throw: the caller is a detached
 *   process with nowhere to report to, and a crash there would leave no verdict AND no trace.
 */
export function writeVerdict(sessionId, record, dir = stateDir()) {
  const target = verdictPath(sessionId, dir);
  // Same directory as the target, because rename across filesystems is not atomic — and the
  // system temp directory is a different filesystem often enough to matter.
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ ...record, written_at: new Date().toISOString() }));
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    return false;
  }
}

/**
 * Read the verdict and remove it, in that order.
 *
 * @returns {object|null} null when there is nothing waiting — the ordinary case, since the
 *   judge usually finishes while the user is still reading.
 */
export function takeVerdict(sessionId, dir = stateDir()) {
  const target = verdictPath(sessionId, dir);
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
  // Unlinked before parsing on purpose. A verdict this version cannot read would otherwise
  // sit there being re-read and re-failed on every turn for the rest of the session.
  try { fs.unlinkSync(target); } catch { /* already gone */ }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Hand a job to the detached judge.
 *
 * It goes through a file rather than stdin because the child is spawned with stdio ignored —
 * that is what lets the hook exit without waiting for it.
 */
export function writeJob(sessionId, job, dir = stateDir()) {
  const target = jobPath(sessionId, dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(job), { mode: 0o600 });
    return target;
  } catch {
    return null;
  }
}

/** Read a job and delete it. The job carries credentials, so it does not outlive its use. */
export function takeJob(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try { fs.unlinkSync(file); } catch { /* already gone */ }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
