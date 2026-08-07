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
 * ## Taking it
 *
 * `open(…, 'wx')` — O_CREAT|O_EXCL. One winner out of any number, no window. That part is
 * easy and is where the whole problem would end if locks never had to expire.
 *
 * ## Reclaiming a dead run's lock, and why it takes three steps
 *
 * A run that is killed leaves the file behind and would block updates forever, so a lock
 * older than STALE_MS is reclaimable. **Deleting a path and re-creating it cannot be made
 * atomic on a plain filesystem.** Whatever you do, a process that decided a file was stale
 * can end up removing a *different* file that has since taken that path — including a fresh
 * lock somebody else legitimately holds. `unlink` has this problem; so does `rename`, which
 * only moves the decision one level down (a late renamer moves the fresh marker instead).
 *
 * So this does not try to be atomic. It bounds the damage instead:
 *
 * 1. **Only one process deletes at a time.** Removal is serialised behind `<lock>.reclaim`,
 *    taken with the same exclusive create.
 * 2. **The deleter re-reads the age immediately before deleting.** A lock created while it
 *    waited its turn is no longer stale, so it is left alone.
 * 3. **The winner verifies it still holds what it made.** If another process deleted our
 *    fresh lock and put its own there, the file at the path is no longer the one we created,
 *    and we stand down rather than both believing we hold it.
 *
 * Step 3 is what makes the residual safe rather than merely unlikely: displacement is
 * *detected* by whoever was displaced. What is left is a process displaced in the few
 * microseconds after its own check, which needs a `.reclaim` leaked by a `SIGKILL` inside a
 * three-syscall window plus two hooks arriving together. Not zero. Bounded, and stated,
 * which the previous version of this comment was not.
 */

import fs from 'fs';

/** A lock untouched for this long is assumed to belong to a run that died. */
export const STALE_MS = 5 * 60 * 1000;

/** Suffix of the short-lived file that serialises stale-lock reclamation. */
const RECLAIM_SUFFIX = '.reclaim';

/** Reasons that mean "somebody else is doing it" rather than "something went wrong". */
export const CONTENTION_REASONS = ['lock_held', 'displaced'];

/** @returns {boolean} true when a failed acquire was contention, not a fault. */
export function isContention(reason) {
  return CONTENTION_REASONS.includes(reason);
}

/**
 * A value only this acquisition will write, used to tell our lock from a replacement.
 *
 * Content rather than inode: the shell hook has to be able to do the same check, and it
 * cannot get at the descriptor it created — `stat` by name would compare the replacement
 * with itself and always agree. Writing a token and reading it back works identically in
 * both, and on Windows, where inode numbers are not dependable.
 */
function mintToken() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Create `file` only if it does not exist yet, stamping `token` into it.
 * @returns {{ok: true} | {ok: false, code: string, error: Error}} `EEXIST` means somebody
 *   else has it.
 */
function createExclusive(file, token = '') {
  let fd;
  try {
    fd = fs.openSync(file, 'wx');   // O_CREAT | O_EXCL — one winner, no window
  } catch (e) {
    return { ok: false, code: e.code || 'EUNKNOWN', error: e };
  }
  try {
    if (token) fs.writeSync(fd, token);
  } catch { /* an unwritable token only costs us the verification below */ }
  try { fs.closeSync(fd); } catch { /* nothing useful to do */ }
  return { ok: true };
}

/** @returns {boolean} whether the file at `file` is still the one that wrote `token`. */
function stillOurs(file, token) {
  try {
    return fs.readFileSync(file, 'utf8') === token;
  } catch {
    return false;   // deleted out from under us — we do not hold it
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

  // A reclaimer killed mid-flight leaves this behind and would block every future reclaim.
  // Clearing it is itself a delete-and-recreate, so it gets the same treatment: move it
  // aside under a name only this process uses, and let whoever loses skip this round. The
  // lock then stays stale until the next session, which costs nothing.
  if (ageMs(reclaim, now()) > staleMs) {
    const parked = `${reclaim}.dead.${process.pid}`;
    try {
      fs.renameSync(reclaim, parked);
      fs.unlinkSync(parked);
    } catch {
      return;   // somebody else is clearing it — do not race them for it
    }
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
 *   `lock_held`, `displaced`, or the errno of whatever stopped us. Callers report
 *   contention (see `isContention`) as a skip and anything else as a failure, because they
 *   mean different things to whoever reads the log: one is another process doing the work,
 *   the other is a read-only filesystem or a full disk.
 */
export function tryAcquireUpdateLock(lockFile, opts = {}) {
  const { staleMs = STALE_MS, now = Date.now } = opts;
  reclaimIfStale(lockFile, staleMs, now);

  const token = mintToken();
  const created = createExclusive(lockFile, token);
  if (!created.ok) {
    return {
      acquired: false,
      reason: created.code === 'EEXIST' ? 'lock_held' : created.code,
      error: created.error,
    };
  }

  // Step 3: is the file at that path still the one we just made? If a reclaimer deleted it
  // and put its own there, it is not, and it — not us — holds the lock now.
  if (!stillOurs(lockFile, token)) {
    return { acquired: false, reason: 'displaced' };
  }

  return { acquired: true, reason: 'acquired', token };
}

/**
 * Boolean form, for callers that treat every non-acquisition the same way. Prefer
 * `tryAcquireUpdateLock` where the difference between contention and a disk error is going
 * to be written to a log somebody reads.
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
