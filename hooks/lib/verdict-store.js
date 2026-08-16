/**
 * Where a verdict waits between the turn that produced it and the turn that reads it.
 *
 * The judge runs on the user's own subscription, which takes 29–54 seconds — measured, real
 * CLI, real payload. Nobody waits that long after every reply, so the Stop hook starts the
 * judge and returns, and the next `UserPromptSubmit` picks up whatever has landed. This file
 * is the handover.
 *
 * ONE FILE PER JUDGED TURN, NOT PER SESSION. The first version named both files after the
 * session alone, and a session has many turns. Turn N+1's verdict landed on turn N's, so a
 * violation found on the earlier reply was deleted by the later reply being clean — with no
 * trace, because deleting a file that was about to be read looks exactly like never having
 * written one. The job file collided the same way and was worse: the judge whose job had been
 * overwritten read nothing, wrote nothing, and exited.
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

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Same shape the gate uses; anything outside it could steer a path out of the state dir. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/**
 * How long a judge may take before a marker with no verdict means it is never coming.
 *
 * The judge's own ceiling is 90s, plus two 15s HTTP calls and the CLI's ~10s start. Three
 * minutes leaves room for a loaded machine without leaving a dead judge unreported for long.
 */
export const JUDGE_DEADLINE_MS = 180_000;

/** Enough of the reply to recognise which one a late verdict is about. */
const EXCERPT_CHARS = 160;

export function stateDir() {
  return process.env.OWNMIND_STATE_DIR || path.join(os.homedir(), '.ownmind', 'state');
}

const safe = (value) => (typeof value === 'string' && SAFE_ID.test(value) ? value : 'unknown');

/**
 * An identity for one judged turn: when it started, and which reply it was.
 *
 * The timestamp orders them and the digest separates two turns that began in the same
 * millisecond. The digest is also what recognises the SAME reply arriving twice — the Stop
 * hook sits ahead of the `stop_hook_active` return by design, so one reply can reach it more
 * than once, and judging it twice spends the user's own subscription twice.
 */
export function makeTurnId(assistantText) {
  return `${Date.now().toString(36)}-${textHash(assistantText)}`;
}

export function textHash(assistantText) {
  return crypto.createHash('sha256').update(String(assistantText ?? '')).digest('hex').slice(0, 12);
}

export function replyExcerpt(assistantText) {
  return String(assistantText ?? '').replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS);
}

/**
 * A directory per session rather than a session prefix in the filename.
 *
 * Session ids may contain `-` and so may turn ids, so any single-filename scheme needs a
 * separator neither can produce — and the moment one can, `session-a` starts reading
 * `session-a-b`'s verdicts. A directory has no such question, and it makes "everything this
 * session is waiting on" one readdir.
 */
export function verdictDir(sessionId, dir = stateDir()) {
  return path.join(dir, 'verdicts', safe(sessionId));
}

export function verdictPath(sessionId, turnId, dir = stateDir()) {
  return path.join(verdictDir(sessionId, dir), `${safe(turnId)}.json`);
}

export function jobPath(sessionId, turnId, dir = stateDir()) {
  return path.join(dir, 'jobs', safe(sessionId), `${safe(turnId)}.json`);
}

/**
 * Put a verdict where the next turn will find it.
 *
 * @returns {boolean} true when it landed. False rather than a throw: the caller is a detached
 *   process with nowhere to report to, and a crash there would leave no verdict AND no trace.
 */
export function writeVerdict(sessionId, turnId, record, dir = stateDir()) {
  const target = verdictPath(sessionId, turnId, dir);
  // Same directory as the target, because rename across filesystems is not atomic — and the
  // system temp directory is a different filesystem often enough to matter.
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({
      ...record,
      session_id: sessionId,
      turn_id: turnId,
      written_at: new Date().toISOString(),
    }));
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    return false;
  }
}

/**
 * Everything this session is waiting on, oldest first.
 *
 * A file that will not parse comes back as a failure rather than being skipped. It is a turn
 * whose verdict is unreadable, which is a turn that went unchecked — and dropping it here is
 * the same silence this whole file exists to remove. It can still be attributed to its
 * session because the session is the directory, not a substring of the name.
 *
 * @returns {Array<{turnId: string, record: object}>}
 */
export function listVerdicts(sessionId, dir = stateDir()) {
  const home = verdictDir(sessionId, dir);
  let names;
  try {
    names = fs.readdirSync(home);
  } catch {
    return [];
  }

  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;      // a `.tmp` mid-rename is not ours to read
    const turnId = name.slice(0, -'.json'.length);
    let record;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(home, name), 'utf8'));
      record = parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      record = null;
    }
    out.push({
      turnId,
      record: record || { outcome: 'failed', failure: 'unreadable', reason: 'the verdict file could not be read', violations: [] },
    });
  }

  return out.sort((a, b) => started(a.record) - started(b.record));
}

function started(record) {
  if (Number.isFinite(record?.started_at)) return record.started_at;
  const written = Date.parse(record?.written_at ?? '');
  return Number.isFinite(written) ? written : 0;
}

export function removeVerdict(sessionId, turnId, dir = stateDir()) {
  try {
    fs.unlinkSync(verdictPath(sessionId, turnId, dir));
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand a job to the detached judge.
 *
 * It goes through a file rather than stdin because the child is spawned with stdio ignored —
 * that is what lets the hook exit without waiting for it.
 */
export function writeJob(sessionId, turnId, job, dir = stateDir()) {
  const target = jobPath(sessionId, turnId, dir);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
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

/**
 * Verdict directories belonging to sessions that ended long ago.
 *
 * Each session leaves at most one file behind — the last turn's, judged after the user
 * stopped typing — but "at most one, forever" is still a leak. Swept on collection rather
 * than on a timer, because there is no timer.
 */
export function sweepStaleSessions(dir = stateDir(), { olderThanMs = 7 * 24 * 60 * 60 * 1000, now = Date.now } = {}) {
  const root = path.join(dir, 'verdicts');
  let sessions;
  try {
    sessions = fs.readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const session of sessions) {
    const home = path.join(root, session);
    try {
      const entries = fs.readdirSync(home);
      const fresh = entries.some((name) => now() - fs.statSync(path.join(home, name)).mtimeMs < olderThanMs);
      if (fresh) continue;
      for (const name of entries) fs.unlinkSync(path.join(home, name));
      fs.rmdirSync(home);
      removed += 1;
    } catch { /* another process got there first, or it is not ours to remove */ }
  }
  return removed;
}
