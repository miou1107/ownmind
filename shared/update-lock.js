/**
 * v1.26.98 — the one implementation of the `~/.ownmind/.update-lock` protocol.
 *
 * Three programs run the daily self-update and must not overlap: the MCP, the Node
 * SessionStart hook and the shell SessionStart hook. They all `git pull`, `npm install` and
 * run `update.sh` in the same directory, so two at once can leave a half-updated tree.
 *
 * Only the MCP ever took the lock properly. The Node hook checked for the file and then
 * created nothing; the shell hook tested for absence and then ran `touch`, which succeeds
 * on a file that already exists. Measured on one account: four hooks entered together every
 * morning for six days.
 *
 * The shell hook cannot import this — spawning node to take a lock costs more than the lock
 * saves — so `acquire_update_lock()` in hooks/ownmind-session-start.sh mirrors it step for
 * step, and tests/update-lock-mutual-exclusion.test.js runs both against the same scenarios.
 *
 * ## Why reclaiming a stale lock is not just `unlink`
 *
 * A run that is killed leaves the file behind and would block updates forever, so a lock
 * older than STALE_MS is reclaimable. The obvious `stat, unlink, create` is itself a race:
 * two processes both see a stale lock, the first unlinks and creates, and the second's
 * unlink then deletes that brand-new lock before creating its own. Both believe they hold
 * it — the same bug, one level up.
 *
 * So deletion is serialised behind a second exclusive file, and whoever wins it re-checks
 * the age before deleting. A lock created in the meantime is no longer stale, so it is left
 * alone; the late reclaimer simply fails its own acquire and steps aside.
 */

import fs from 'fs';

/** A lock untouched for this long is assumed to belong to a run that died. */
export const STALE_MS = 5 * 60 * 1000;

/** Suffix of the short-lived file that serialises stale-lock reclamation. */
const RECLAIM_SUFFIX = '.reclaim';

/**
 * Create `file` only if it does not exist yet.
 * @returns {{ok: true} | {ok: false, code: string}} `EEXIST` means somebody else has it.
 */
function createExclusive(file) {
  try {
    fs.closeSync(fs.openSync(file, 'wx'));   // O_CREAT | O_EXCL — one winner, no window
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.code || 'EUNKNOWN', error: e };
  }
}

/** Age in milliseconds, or null when the file is not there. */
function ageMs(file, now) {
  try {
    return now - fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Delete `lockFile` if, and only if, it is still older than `staleMs` at the moment of
 * deletion and no other process is doing the same thing.
 */
function reclaimIfStale(lockFile, staleMs, now) {
  if (!(ageMs(lockFile, now()) > staleMs)) return;   // null > n is false — nothing to reclaim

  const reclaim = lockFile + RECLAIM_SUFFIX;
  // A reclaimer that died holding this would block every future reclaim. Removing it
  // unconditionally is safe: the only thing it guards is the re-check below, which stands on
  // its own.
  if (ageMs(reclaim, now()) > staleMs) {
    try { fs.unlinkSync(reclaim); } catch { /* somebody else removed it first */ }
  }
  if (!createExclusive(reclaim).ok) return;          // another process is already reclaiming

  try {
    // Re-read the age now that we are the only reclaimer. If the winner of an earlier
    // reclaim has already put a fresh lock here, this is no longer stale and must not be
    // touched — deleting it is what would let two processes update at once.
    if (ageMs(lockFile, now()) > staleMs) {
      try { fs.unlinkSync(lockFile); } catch { /* already gone */ }
    }
  } finally {
    try { fs.unlinkSync(reclaim); } catch { /* best effort */ }
  }
}

/**
 * Take the update lock.
 *
 * @param {string} lockFile
 * @param {{staleMs?: number, now?: () => number}} [opts]
 * @returns {{acquired: boolean, reason: string, error?: Error}} `reason` is `acquired`,
 *   `lock_held`, or the errno of whatever stopped us — the caller reports a held lock as a
 *   skip and anything else as a failure, because they mean different things to whoever reads
 *   the log. `error` is the original exception, for callers that enrich it further.
 */
export function tryAcquireUpdateLock(lockFile, opts = {}) {
  const { staleMs = STALE_MS, now = Date.now } = opts;
  reclaimIfStale(lockFile, staleMs, now);

  const created = createExclusive(lockFile);
  if (created.ok) return { acquired: true, reason: 'acquired' };
  return {
    acquired: false,
    reason: created.code === 'EEXIST' ? 'lock_held' : created.code,
    error: created.error,
  };
}

/**
 * Boolean form, for callers that treat every non-acquisition the same way.
 * @returns {boolean}
 */
export function acquireUpdateLock(lockFile, opts = {}) {
  return tryAcquireUpdateLock(lockFile, opts).acquired;
}

/**
 * Release a lock this process holds. Never call it without having acquired — an unconditional
 * release in an error path is how a process ends up deleting somebody else's lock.
 */
export function releaseUpdateLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch { /* already gone */ }
}
