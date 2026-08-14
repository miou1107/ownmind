import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A real Postgres with this repo's migrations applied, for the queries that cannot be
 * proved any other way.
 *
 * `team_standard` rows are readable across accounts and their prohibition text often lives
 * in child `standard_detail` rows. Both facts are expressed only in SQL — in
 * `buildReadableWhere` and in the fragment lookup — so a test that hands a route its own
 * array of rows proves nothing about either. The compliance judge was first written with a
 * plain `WHERE user_id = $1`; measured against a real database on 2026-08-13, that query
 * cannot see a standard a colleague uploaded, which is exactly the standard the feature was
 * built to enforce. No amount of injected fixtures would have shown it.
 *
 * Returns null when docker is unavailable, so the suite still runs on a machine without it.
 * Callers must skip loudly rather than pass quietly: a database test that silently did not
 * run is the same shape of lie this whole feature exists to remove.
 */

const READY_ATTEMPTS = 40;

/**
 * v1.26.174 — one database container on this machine at a time.
 *
 * `node --test` runs every file in its own process, in parallel up to the CPU count. Each
 * DB-backed file starts its own postgres, and there are now four of them. Measured
 * 2026-08-14 across two full-suite runs: with four containers alive under the load of ~5300
 * other tests, one DB file failed each run — a different one each time, once as every
 * migration erroring at container start, once as `500 認證過程發生錯誤` from a query mid-test
 * (the pool, not the code under test). Run those same four files together on an idle machine
 * and they pass; the fourth file is what tipped it, and nothing about the product was
 * involved either time.
 *
 * A lock rather than a bigger timeout: the second failure happened at request time, long
 * after any readiness probe would have passed, so waiting longer up front does not address
 * it. Holding the containers to one at a time removes the contention instead of outlasting
 * it, and costs about twenty seconds of wall-clock across the whole suite.
 *
 * `mkdir` is the primitive because it is atomic on every platform this suite runs on —
 * exactly one caller can create a given directory. A crashed holder is recovered from rather
 * than deadlocked on: the owner's pid is recorded inside, and a lock whose owner is gone (or
 * that is older than the stale window) is broken and retaken.
 */
const LOCK_DIR = path.join(os.tmpdir(), 'ownmind-test-db.lock');
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 250;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

const OWNER_FILE = () => path.join(LOCK_DIR, 'owner.json');

function readOwner() {
  try { return JSON.parse(fs.readFileSync(OWNER_FILE(), 'utf8')); } catch { return null; }
}

/**
 * Liveness first, age only as the fallback.
 *
 * The first cut asked "is it older than the stale window?" before "is the holder alive?", and
 * `at` is stamped once at acquire with no heartbeat. A live holder that simply took longer than
 * the window was therefore declared gone and its lock stolen out from under it — two containers
 * at once, which is the state this lock exists to prevent. A pid that answers is alive, however
 * long it has been working; the age check is only for the case where the pid tells us nothing.
 */
function lockHolderIsGone() {
  const owner = readOwner();
  // No owner record at all: a half-created lock, or one from a version that did not write it.
  // Nothing to ask about liveness, so age it out rather than breaking it immediately.
  if (!owner || !Number.isInteger(owner.pid)) {
    try { return Date.now() - fs.statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS; } catch { return true; }
  }
  try {
    // Signal 0 checks for existence without delivering anything. ESRCH means the holder died
    // without releasing; EPERM means it exists and belongs to someone else, so it is alive.
    process.kill(owner.pid, 0);
    return false;
  } catch (err) {
    if (err.code === 'ESRCH') return true;
    // Any other error (EPERM, or a pid this platform will not answer for) leaves liveness
    // unknown; fall back to age so an unanswerable pid cannot block forever.
    return Date.now() - (owner.at || 0) > LOCK_STALE_MS;
  }
}

/** The token this process wrote, so a release can prove the lock is still its own. */
let heldToken = null;

async function acquireDbLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      // The token, not just the pid: pids are reused, and after a steal the previous holder
      // must not be able to delete the new holder's lock on its way out.
      heldToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      fs.writeFileSync(OWNER_FILE(), JSON.stringify({ pid: process.pid, at: Date.now(), token: heldToken }));
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (lockHolderIsGone()) {
        // Delete the record we judged, not whatever is there now: between the judgement and
        // this line another waiter may already have broken and retaken the lock, and removing
        // a live holder's directory is the same two-containers bug by a different route.
        const stale = readOwner();
        try {
          if (!stale || readOwner()?.token === stale?.token) {
            fs.rmSync(LOCK_DIR, { recursive: true, force: true });
          }
        } catch { /* raced with another breaker; fall through and retry */ }
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the test database lock at ${LOCK_DIR}`);
      }
      // Always sleep, including after a break attempt: a break that keeps failing (a foreign
      // holder's directory on a shared tmp) would otherwise spin without ever reaching the
      // deadline check above.
      await new Promise((resolve) => { setTimeout(resolve, LOCK_POLL_MS); });
    }
  }
}

function releaseDbLock() {
  if (!heldToken) return;
  // Only if it is still ours. If we were judged stale and someone else took over, deleting the
  // directory here would free a lock that another process is actively holding.
  try {
    if (readOwner()?.token === heldToken) fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch { /* already gone */ }
  heldToken = null;
}

/**
 * @param {object}  [opts]
 * @param {string}  [opts.image]  postgres image to run
 * @param {number}  [opts.port]   host port to publish on
 * @param {string}  [opts.name]   container name, so a leftover can be replaced not duplicated
 * @returns {Promise<{name: string, port: number, psql: (sql: string) => string,
 *                    applyMigrations: (dir: string) => void, stop: () => void} | null>}
 */
export async function startRealDb({
  image = 'pgvector/pgvector:pg16',
  // Derived from the process id rather than fixed. Two suites running at once - or one run
  // starting while the previous container is still going away - would otherwise collide on
  // the port, and the failure surfaces as an unrelated test failing once in a while, which
  // is the hardest kind to track down.
  port = 55000 + (process.pid % 2000),
  name = `ownmind-test-db-${port}`,
} = {}) {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
  } catch {
    return null;
  }

  // Taken after the docker check so a machine without docker still returns null instantly
  // rather than queueing behind a lock it will never need.
  await acquireDbLock();
  // Everything from here to the successful return runs guarded: `docker run` can throw (image
  // pull failure, a port already bound) and an unguarded throw would exit startRealDb with the
  // lock still held and the container still up. The lock recovers on its own once the process
  // dies — the next waiter's `process.kill` gets ESRCH — but until then the other DB files
  // block, and the orphaned container is never reclaimed, because the next process derives a
  // different name from its own pid.
  try {
    return await startContainer({ image, port, name });
  } catch (err) {
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch { /* none */ }
    releaseDbLock();
    throw err;
  }
}

/** The body of startRealDb, once the lock is held. Never call this without it. */
async function startContainer({ image, port, name }) {
  try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch { /* none */ }
  execFileSync('docker', ['run', '-d', '--name', name,
    '-e', 'POSTGRES_PASSWORD=test',
    '-e', 'POSTGRES_USER=ownmind',
    '-e', 'POSTGRES_DB=ownmind',
    '-p', `${port}:5432`,
    image], { stdio: 'ignore' });

  // v1.26.174 — the probe is a real query, not pg_isready.
  //
  // The postgres entrypoint runs initdb against a *temporary* server that listens on the unix
  // socket only, then stops it and starts the real one. `pg_isready` answers yes during that
  // window, so a `docker exec psql` a moment later can land in the gap between the two and
  // fail with `connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No
  // such file or directory`. Measured 2026-08-14: with four DB-backed test files in one suite
  // run starting four containers at once, initdb takes long enough for that gap to be hit, and
  // the failure surfaced as every migration erroring — 001 on the socket, then 002-025 on
  // "relation does not exist" — in a file that passes on its own. Nothing about the code under
  // test was involved.
  //
  // Asking the server to answer a query is the only probe that cannot be satisfied by the
  // temporary one being up: it runs through the same `docker exec psql` path the caller uses.
  let ready = false;
  for (let i = 0; i < READY_ATTEMPTS; i += 1) {
    try {
      execFileSync(
        'docker',
        ['exec', '-i', name, 'psql', '-U', 'ownmind', '-d', 'ownmind', '-v', 'ON_ERROR_STOP=1',
          '-tA', '-c', 'SELECT 1'],
        { stdio: 'ignore' },
      );
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, 1000); });
    }
  }
  // The lock is released here and only here, so every exit path a caller has — the `finally`
  // of a passing test, of a failing one, and the `!ready` throw below — hands it on. Removing
  // the container first: the next holder starts its own the moment it acquires, and two
  // postgres containers alive at once is exactly what the lock exists to prevent.
  const stop = () => {
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch { /* gone */ }
    releaseDbLock();
  };
  if (!ready) {
    stop();
    throw new Error(`postgres container ${name} never became ready`);
  }

  /** Run SQL and return stdout. Throws on error, so a broken fixture fails the test. */
  const psql = (sql) => execFileSync(
    'docker',
    ['exec', '-i', name, 'psql', '-U', 'ownmind', '-d', 'ownmind', '-v', 'ON_ERROR_STOP=1', '-tA'],
    { input: sql, encoding: 'utf8' },
  );

  /**
   * Apply every db/NNN_*.sql in order.
   *
   * A migration that fails is reported, not swallowed: some of this repo's migrations assume
   * data that a blank database does not have, and the difference between "did not apply
   * because it was irrelevant" and "did not apply because it is broken" is one a caller has
   * to be able to see.
   */
  const applyMigrations = (dir) => {
    const files = execFileSync('ls', [dir], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort();
    const skipped = [];
    for (const file of files) {
      try {
        execFileSync(
          'docker',
          ['exec', '-i', name, 'psql', '-U', 'ownmind', '-d', 'ownmind', '-v', 'ON_ERROR_STOP=1', '-q'],
          { input: execFileSync('cat', [`${dir}/${file}`], { encoding: 'utf8' }), encoding: 'utf8' },
        );
      } catch (err) {
        skipped.push(`${file}: ${String(err.stderr || err.message).split('\n')[0]}`);
      }
    }
    return skipped;
  };

  return { name, port, psql, applyMigrations, stop };
}
