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
 * 2. **The marker's holder proves the marker is still its own before deleting anything.**
 *    Clearing a *leaked* marker is itself a delete-and-recreate, so a marker that is alive
 *    can be deleted by a process that mistook it for a dead one. That does not merely
 *    inconvenience its owner: the marker is the mutex, so its owner is now inside an
 *    unguarded section, and the next arrival walks in beside it.
 * 3. **The deleter re-reads the age immediately before deleting.** A lock created while it
 *    waited its turn is no longer stale, so it is left alone.
 * 4. **The winner verifies it still holds what it made.** If another process deleted our
 *    fresh lock and put its own there, the file at the path is no longer the one we created,
 *    and we stand down rather than both believing we hold it.
 *
 * Steps 2 and 4 are what make the residual safe rather than merely unlikely: displacement is
 * *detected* by whoever was displaced, at both levels.
 *
 * v1.26.145 added step 2, after CI caught the shell twin admitting two processes and the
 * scenario was reproduced under load: sixteen contenders against a leaked marker gave 10
 * double acquisitions in 240 rounds — three processes inside the section at once, not the
 * "few microseconds" this comment used to claim. With step 2 the same 240 rounds produced
 * none. What is left is rounds in which nobody reclaims (3 in 400), which costs one skipped
 * update and is the safe direction.
 */

import fs from 'fs';

/** A lock untouched for this long is assumed to belong to a run that died. */
// v1.26.142 — raised from 5 minutes.
//
// The upgrade's own worst case is 280 seconds of legitimate work (30s fetch + 10s log +
// 30s + 30s for both pull attempts + 120s npm + 60s sync), which left twenty seconds of
// headroom before a healthy holder was declared dead — and on Windows, `execFile`'s
// timeout settles only when the child's stdio closes, so a grandchild npm can hold on well
// past its own kill. A reclaim in that window is not a recovery; it is a second upgrade
// starting on top of a running one.
//
// Ten minutes clears the worst case by a factor of two. The cost is that a genuinely dead
// holder blocks for ten minutes instead of five, which delays one upgrade by one scanner
// interval at most.
export const STALE_MS = 10 * 60 * 1000;

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
    } catch {
      return;   // somebody else is clearing it — do not race them for it
    }
    // v1.26.111 — winning the rename does not establish that what moved is what was
    // measured. A process that wins the same move, clears it, and creates its own fresh
    // marker puts a file back at that path, and this rename then succeeds on that one.
    // Both would be inside the section below, where the age re-read only protects the first
    // one's new lock once that lock exists. So check what was actually taken: a fresh marker
    // means somebody is reclaiming right now, and this call stands down.
    const parkedAge = ageMs(parked, now());
    try { fs.unlinkSync(parked); } catch { /* best effort */ }
    if (!(parkedAge > staleMs)) return;
  }

  // v1.26.145 — the marker carries a token, for the same reason the lock does.
  //
  // The block above deletes the marker it moved aside, and that marker is sometimes a live
  // one: a process is inside the section right now and this call has just removed the mutex
  // guarding it. Standing down (v1.26.111) keeps *this* process out; it does nothing about
  // the next one, which finds the path free and walks in. Measured on the shell twin on
  // 2026-08-11 with sixteen contenders under load: three processes inside at once, two of
  // them acquiring — 10 double acquisitions in 240 rounds.
  //
  // Restoring the marker was tried and measured worse than the bug (45 in 120): a restore is
  // a second window in which the mutex is absent, and `rename` clobbers whatever took the
  // path meanwhile. What works is checking from the other end. An occupant that has lost its
  // marker is not an occupant, and must not delete anything on the strength of an age it
  // read while it still was one. With that check the same 240 rounds produced no double
  // acquisition at all.
  const rtoken = mintToken();
  if (!createExclusive(reclaim, rtoken).ok) return;   // another process is already reclaiming

  try {
    // Re-read the age now that we are the only reclaimer. If the winner of an earlier
    // reclaim has already put a fresh lock here, this is no longer stale and must not be
    // touched — deleting it is what would let two processes update at once.
    //
    // `stillOurs` last, immediately before the unlink: the age read is the slow part, and
    // the marker can be taken away while it happens.
    if (ageMs(lockFile, now()) > staleMs && stillOurs(reclaim, rtoken)) {
      try { fs.unlinkSync(lockFile); } catch { /* already gone */ }
    }
  } finally {
    // Only ever remove a marker that is still ours. Removing somebody else's is how the
    // mutex came to evaporate in the first place.
    if (stillOurs(reclaim, rtoken)) {
      try { fs.unlinkSync(reclaim); } catch { /* best effort */ }
    }
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
 *
 * v1.26.142 — pass the token `tryAcquireUpdateLock` returned, and the release becomes safe
 * even when that warning is ignored.
 *
 * The warning alone stopped being enough once the scheduled scanner joined the MCP and the
 * two hooks as a contender: four programs, one of them running every two hours on every
 * machine, and a hold that can legitimately last minutes. If a holder overruns the stale
 * threshold, the next contender reclaims the lock and starts work; when the first one then
 * finishes and releases, an unconditional unlink deletes the *reclaimer's* lock, a third
 * process acquires, and two upgrades run into the same directory at once — which is the
 * one outcome this lock exists to prevent.
 *
 * With a token, a release that is no longer ours is a no-op. Callers that pass nothing keep
 * the old unconditional behaviour, so nothing that has not been read and considered changes.
 *
 * @param {string} lockFile
 * @param {string} [token] the value returned by tryAcquireUpdateLock
 * @returns {boolean} whether this call removed the lock
 */
export function releaseUpdateLock(lockFile, token) {
  if (token && !stillOurs(lockFile, token)) return false;
  try { fs.unlinkSync(lockFile); return true; } catch { return false; }
}
