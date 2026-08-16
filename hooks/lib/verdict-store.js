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
 * The judge's own ceiling is 300s, plus two 15s HTTP calls and the CLI's ~10s start: 340s
 * before a judge that is merely slow would be called dead. 420s is that with room to spare.
 *
 * This is the number the previous comment said to raise, and the reason it gave is the reason
 * it was raised: real latency was measured at 150s against a bench that had suggested 18s, so
 * the 180s that looked generous was in fact one slow turn away from calling live judges dead.
 *
 * The cost of erring long is that a judge which really did die goes unreported for seven
 * minutes. That is nearly free here, because nothing is collected until the next time the user
 * types — the report was never going to be prompt, only correct.
 */
export const JUDGE_DEADLINE_MS = 420_000;

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
export function makeTurnId(assistantText, userPrompts) {
  return `${Date.now().toString(36)}-${textHash(assistantText, userPrompts)}`;
}

/**
 * What makes one checked turn the same as another.
 *
 * The prompts are in it, not just the reply. Which rules apply is decided from both, so two
 * byte-identical short replies — "好的。", "Done." — to two different questions are two
 * different checks. Hashing the reply alone made the second one look like a repeat of the
 * first: no judge, no marker, no deadline, and therefore nothing to say it had been skipped.
 */
export function textHash(assistantText, userPrompts = []) {
  const material = JSON.stringify([String(assistantText ?? ''), (userPrompts || []).map(String)]);
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 12);
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
    // 0600, like the job file beside it. This carries 160 characters of what the AI said and
    // the judge's quotes from it, which is the user's own work; on a shared machine the
    // default 0644 hands that to everybody with an account.
    fs.writeFileSync(tmp, JSON.stringify({
      ...record,
      session_id: sessionId,
      turn_id: turnId,
      written_at: new Date().toISOString(),
    }), { mode: 0o600 });
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
    } catch (err) {
      // Gone between the listing and the read is not the same as unreadable. Something else
      // took it — the housekeeping sweep, or a second window on the same session — and
      // announcing "this turn was not checked" there would be a false alarm about a verdict
      // that was, in all likelihood, delivered by whoever took it.
      if (err?.code === 'ENOENT') continue;
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

/**
 * One turn's record, read fresh.
 *
 * The collector lists, then decides, then acts, and the judge can land in between — writing
 * by rename onto exactly this path. Without a second look, a verdict that arrived a second
 * after its deadline would be deleted and announced as a judge that never came back.
 *
 * @returns {object|null|undefined} the record; `null` when it is there and unreadable;
 *   `undefined` when it is GONE. The caller has to tell those apart: unreadable is a turn
 *   that went unchecked, and gone is a turn somebody else has already dealt with.
 */
export function readVerdict(sessionId, turnId, dir = stateDir()) {
  let raw;
  try {
    raw = fs.readFileSync(verdictPath(sessionId, turnId, dir), 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' ? undefined : null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
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
 *
 * Which puts it on the critical path of every prompt, so it was measured rather than
 * reasoned about: 0.6 ms at 10 sessions on disk, 4.6 ms at 100, 15.5 ms at 500, 51 ms at
 * 2000. Steady state is one week of sessions, because that is what this removes — twenty a
 * day lands around 7 ms.
 */
export function sweepStaleSessions(dir = stateDir(), { olderThanMs = 7 * 24 * 60 * 60 * 1000, now = Date.now } = {}) {
  let removed = 0;
  // Both trees, because both leak. A job file is the one that matters: it holds the API key,
  // it is deleted only by the child that reads it, and a child killed before its first read —
  // a reboot, an out-of-memory kill — leaves it there. Under the old per-session naming those
  // overwrote each other; one file per turn makes them accumulate.
  for (const kind of ['verdicts', 'jobs']) {
    const root = path.join(dir, kind);
    let sessions;
    try {
      sessions = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const session of sessions) {
      const home = path.join(root, session);
      try {
        const entries = fs.readdirSync(home);
        // An empty directory is judged by its own age, not by the files it does not have.
        // Treating empty as stale meant the live session's directory — emptied the moment its
        // verdict was delivered — was removed and recreated on every single turn.
        const newest = entries.length
          ? Math.max(...entries.map((name) => fs.statSync(path.join(home, name)).mtimeMs))
          : fs.statSync(home).mtimeMs;
        if (now() - newest < olderThanMs) continue;
        for (const name of entries) fs.unlinkSync(path.join(home, name));
        fs.rmdirSync(home);
        removed += 1;
      } catch { /* another process got there first, or it is not ours to remove */ }
    }
  }
  return removed;
}
