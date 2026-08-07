import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * v1.26.98 — `.update-lock` did not lock.
 *
 * Three programs share `~/.ownmind/.update-lock` so that only one of them runs `git pull`
 * in `~/.ownmind` at a time. Two of the three never actually took it:
 *
 *   hooks/ownmind-session-start.sh   `[ ! -f "$LOCK" ]` … then `touch "$LOCK"`
 *   hooks/ownmind-session-start.js   `existsSync(lock)` … then nothing was ever created
 *   mcp/index.js                     openSync(lock, 'wx')          ← the only correct one
 *
 * Two separate defects in the shell version, either one sufficient:
 *   - the test and the create are ten lines and a `fork` apart, so every concurrent hook
 *     passes the test before the first one creates anything;
 *   - `touch` succeeds on a file that already exists, so even a perfectly ordered pair of
 *     calls both "acquire".
 *
 * Measured 2026-08-07 on one user's activity log: four `update_check` in the same second,
 * then three `update_failed`, then one `update_applied` — every morning for six days. The
 * upgrade did succeed; the three losers reported failure. Harmless that week, but the four
 * were running `git pull`, `npm install` and `update.sh` in the same working tree.
 *
 * The stale-lock takeover had a race of its own in all three: `stat` the age, `rm`, then
 * create. Two processes can both see a stale lock, both remove it, and the second one's
 * `rm` deletes the fresh lock the first one just took.
 *
 * There is no atomic fix for that. Deleting a path and re-creating it can always remove a
 * file that has since taken the path — `rename` does not help, it only moves the same
 * decision one level down. So the implementation bounds it in three steps, and each step has
 * its own test below: removal is serialised behind `<lock>.reclaim`; the deleter re-reads
 * the age immediately before deleting; and the winner reads back a token it wrote, so a
 * process whose lock was displaced finds out and stands down instead of both believing they
 * hold it.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const shellHook = path.join(repoRoot, 'hooks', 'ownmind-session-start.sh');
const CONTENDERS = 8;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-lock-'));
}

/**
 * Extract a shell function from a script by name, so the test runs the code that ships
 * rather than a copy of it. Same technique as tests/shebang-eol.test.js.
 */
function shellFunction(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf(`${name}() {`);
  assert.ok(start > 0, `${path.basename(file)} does not define ${name}()`);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, `${name}() has no closing brace at column 0`);
  return src.slice(start, end + 3);
}

/**
 * Run `bodies` concurrently and return how many printed WIN.
 *
 * Each child spins on a "go" file before touching the lock, so they contend inside the same
 * few hundred microseconds. Without that they run in whatever order the OS schedules them
 * and a broken lock still looks fine.
 */
async function race(dir, makeChild) {
  const go = path.join(dir, 'go');
  const children = Array.from({ length: CONTENDERS }, (_, i) => makeChild(i, go));
  const outs = children.map((c) => {
    let buf = '';
    c.stdout.on('data', (d) => { buf += d; });
    return () => buf;
  });
  // Give every child time to reach its spin loop before releasing them.
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(go, '1');
  await Promise.all(children.map((c) => new Promise((r) => c.on('close', r))));
  return outs.filter((read) => read().includes('WIN')).length;
}

function shellRacer(dir, snippet) {
  return (i, go) => spawn('bash', ['-c', [
    `LOCK_FILE=${JSON.stringify(path.join(dir, '.update-lock'))}`,
    `while [ ! -f ${JSON.stringify(go)} ]; do :; done`,
    snippet,
  ].join('\n')], { stdio: ['ignore', 'pipe', 'ignore'] });
}

describe('v1.26.98 — the harness can see a race at all (positive control)', () => {
  /**
   * A concurrency test that never observes the failure proves nothing: "no double acquire"
   * and "the children never actually overlapped" produce identical output. So run the old
   * shape first and require it to fail. If this stops failing, the guarded tests below are
   * meaningless and must not be trusted. Same reasoning as the positive-control rule that
   * governs any "0 results" claim.
   */
  it('`touch` cannot be an acquire — it succeeds on a file that already exists', () => {
    const dir = tmpdir();
    try {
      const f = path.join(dir, '.update-lock');
      execFileSync('touch', [f]);
      execFileSync('touch', [f]);   // throws only on a non-zero exit
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the old test-then-touch shape lets everybody in', async () => {
    const dir = tmpdir();
    try {
      // Faithful to what shipped: the check was in the outer scope, the touch was inside a
      // backgrounded subshell ten lines later, with a `log_event` (which spawns curl) in
      // between. The sleep stands in for that gap.
      const winners = await race(dir, shellRacer(dir, [
        'if [ ! -f "$LOCK_FILE" ]; then',
        '  sleep 0.05',
        '  touch "$LOCK_FILE" && echo WIN',
        'fi',
      ].join('\n')));
      assert.ok(winners > 1,
        `expected the broken shape to admit several, got ${winners} — the harness is not racing`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('v1.26.98 — the shell hook takes a real lock', () => {
  // The whole protocol, taken from the file that ships. `acquire_update_lock` calls the
  // other two, so extracting it alone would run against `command not found`.
  const acquire = () => ['lock_age_seconds', 'create_exclusive', 'acquire_update_lock']
    .map((n) => shellFunction(shellHook, n)).join('\n');

  it('exactly one of eight concurrent hooks acquires it', async () => {
    const dir = tmpdir();
    try {
      const winners = await race(dir, shellRacer(dir,
        `${acquire()}\nif acquire_update_lock; then echo WIN; fi`));
      assert.equal(winners, 1, `${winners} processes hold the same lock`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a lock held by somebody else is not taken', () => {
    const dir = tmpdir();
    try {
      const lock = path.join(dir, '.update-lock');
      fs.writeFileSync(lock, '');
      const code = spawnSyncStatus(dir, `${acquire()}\nacquire_update_lock`);
      assert.notEqual(code, 0, 'a fresh lock must not be stolen');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a lock left behind by a dead run is taken over, by one process only', async () => {
    const dir = tmpdir();
    try {
      const lock = path.join(dir, '.update-lock');
      fs.writeFileSync(lock, '');
      // Older than the 5-minute staleness threshold.
      const old = new Date(Date.now() - 20 * 60 * 1000);
      fs.utimesSync(lock, old, old);

      const winners = await race(dir, shellRacer(dir,
        `${acquire()}\nif acquire_update_lock; then echo WIN; fi`));
      assert.equal(winners, 1,
        `stale takeover admitted ${winners} — rm-then-create lets a second process delete the first one's new lock`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a leaked reclaim marker does not let two shell hooks into the critical section', async () => {
    // Shell mirror of the same scenario on the Node side. Both stale: a reclaimer that died
    // between creating the marker and removing it.
    const dir = tmpdir();
    try {
      const lock = path.join(dir, '.update-lock');
      const old = new Date(Date.now() - 20 * 60 * 1000);
      for (const f of [lock, lock + '.reclaim']) {
        fs.writeFileSync(f, '');
        fs.utimesSync(f, old, old);
      }
      const winners = await race(dir, shellRacer(dir,
        `${acquire()}\nif acquire_update_lock; then echo WIN; fi`));
      assert.ok(winners <= 1, `${winners} processes hold the same lock`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a process that loses the move-aside does not reclaim', () => {
    // Pins the losing branch of the leaked-marker cleanup on its own. Racing cannot reach
    // it: the displacement check further down catches the damage, so the whole layer can be
    // removed without any concurrency test going red — which is exactly how a defence-in-
    // depth layer rots away unnoticed. `mv` is shadowed to fail, which is what losing the
    // move looks like from inside.
    const dir = tmpdir();
    try {
      const lock = path.join(dir, '.update-lock');
      const old = new Date(Date.now() - 20 * 60 * 1000);
      for (const p of [lock, lock + '.reclaim']) {
        fs.writeFileSync(p, 'held-by-somebody');
        fs.utimesSync(p, old, old);
      }
      const code = spawnSyncStatus(dir,
        `${acquire()}\nmv() { return 1; }\nacquire_update_lock`);
      assert.notEqual(code, 0, 'reclaimed anyway after losing the move');
      assert.equal(fs.readFileSync(lock, 'utf8'), 'held-by-somebody',
        'deleted the stale lock despite losing the right to');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a displaced shell hook stands down', () => {
    // Step three in the shell. `create_exclusive` is shadowed so the file ends up holding
    // somebody else's token — indistinguishable, from inside, from having been deleted and
    // replaced between the create and the read-back.
    const dir = tmpdir();
    try {
      const code = spawnSyncStatus(dir, [
        acquire(),
        'create_exclusive() { ( set -C; printf %s somebody-elses-token > "$1" ) 2>/dev/null; }',
        'acquire_update_lock',
      ].join('\n'));
      assert.notEqual(code, 0, 'kept holding a lock whose contents are somebody else\'s');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('will not delete a stale lock while somebody else is reclaiming it', () => {
    // The shell mirror of the deterministic reclaim test below; see the comment there for
    // why racing alone does not pin this.
    const dir = tmpdir();
    try {
      const lock = path.join(dir, '.update-lock');
      const old = new Date(Date.now() - 20 * 60 * 1000);
      fs.writeFileSync(lock, '');
      fs.utimesSync(lock, old, old);
      fs.writeFileSync(lock + '.reclaim', '');

      assert.notEqual(spawnSyncStatus(dir, `${acquire()}\nacquire_update_lock`), 0,
        'took the lock out from under the process that is reclaiming it');
      assert.ok(fs.existsSync(lock),
        'deleted a lock somebody else was in the middle of handling');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves no reclaim marker behind', async () => {
    // A leaked `.reclaim` blocks every future reclaim for five minutes, so it has to be
    // cleaned up on every path out. The first version of this test looked for `.stale`
    // files, which nothing has ever created — it could not fail. `.reclaim` is the name the
    // code actually uses.
    const dir = tmpdir();
    try {
      const lock = path.join(dir, '.update-lock');
      fs.writeFileSync(lock, '');
      const old = new Date(Date.now() - 20 * 60 * 1000);
      fs.utimesSync(lock, old, old);
      await race(dir, shellRacer(dir,
        `${acquire()}\nif acquire_update_lock; then echo WIN; fi`));
      assert.deepEqual(
        fs.readdirSync(dir).filter((f) => f.includes('.reclaim') || f.includes('.dead')), [],
        'a leaked reclaim marker stops this machine reclaiming for five minutes');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function spawnSyncStatus(dir, snippet) {
  const r = execFileSync('bash', ['-c', [
    `LOCK_FILE=${JSON.stringify(path.join(dir, '.update-lock'))}`,
    snippet,
    'echo $?',
  ].join('\n')], { encoding: 'utf8' });
  return Number(r.trim().split('\n').pop());
}

describe('v1.26.98 — losing the race is a skip, not a failure', () => {
  const src = fs.readFileSync(shellHook, 'utf8');

  it('a held lock is a skip; only a lock that could not be created is a failure', () => {
    // The `update_failed step=lock` line produced 18 phantom failures, but deleting it
    // outright would lose the case it was written for: a read-only filesystem or a full
    // disk, where the update genuinely cannot proceed. `set -C` cannot report an errno, so
    // the two are told apart by whether a lock file is there to account for the refusal.
    // The MCP already calls the first case `update_skipped` / `lock_held`; the two must
    // agree, or the same event reads as two different things depending on the machine.
    assert.match(src,
      /elif \[ -f "\$LOCK_FILE" \]; then[\s\S]{0,700}update_skipped[\s\S]{0,700}else[\s\S]{0,700}update_failed" "step" "lock"/,
      'losing a lock race must not be recorded as a failed upgrade');
  });

  it('and the winner is the only one that logs update_check', () => {
    // Four `update_check` in one second was the visible symptom. The lock has to be taken
    // before the event is logged, otherwise the log still shows a stampede.
    const checkAt = src.indexOf('log_event "update_check"');
    const acquireAt = src.indexOf('acquire_update_lock;');
    assert.ok(acquireAt > 0 && acquireAt < checkAt,
      'acquire the lock before logging update_check, not after');
  });
});

describe('v1.26.98 — the Node side uses one shared implementation', () => {
  const shared = path.join(repoRoot, 'shared', 'update-lock.js');

  it('exists, so the MCP and the Node hook cannot drift apart', () => {
    assert.ok(fs.existsSync(shared), 'shared/update-lock.js is missing');
  });

  for (const [label, file] of [
    ['the MCP', path.join(repoRoot, 'mcp', 'index.js')],
    ['the Node session-start hook', path.join(repoRoot, 'hooks', 'ownmind-session-start.js')],
  ]) {
    it(`${label} imports it rather than rolling its own`, () => {
      // includes(), not assert.match(): a failing match prints the entire file.
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(src.includes("from '../shared/update-lock.js'"),
        `${label} does not import the shared lock`);
      assert.ok(/\b(try)?[aA]cquireUpdateLock\(/.test(src),
        `${label} imports the shared lock but never calls it`);
      assert.ok(!/openSync\(\s*LOCK_FILE\s*,\s*'wx'\s*\)/.test(src),
        `${label} still has its own copy of the acquire`);
    });
  }

  it('exactly one of eight concurrent processes acquires it', async () => {
    const dir = tmpdir();
    try {
      const winners = await race(dir, (i, go) => spawn(process.execPath, ['-e', `
        const fs = require('fs');
        const go = process.argv[1], lock = process.argv[2];
        // Resolve and compile the module BEFORE the start signal. Doing it after meant each
        // child paid a different module-load cost and they reached the acquire spread out
        // rather than together — which is why two reclaim mutants survived the first pass.
        import(process.argv[3]).then(({ acquireUpdateLock }) => {
          while (!fs.existsSync(go)) { /* spin */ }
          if (acquireUpdateLock(lock)) console.log('WIN');
        });
      `, go, path.join(dir, '.update-lock'), shared], { stdio: ['ignore', 'pipe', 'ignore'] }));
      assert.equal(winners, 1, `${winners} processes hold the same lock`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stale lock is taken over by one process only', async () => {
    const dir = tmpdir();
    try {
      const lock = path.join(dir, '.update-lock');
      fs.writeFileSync(lock, '');
      const old = new Date(Date.now() - 20 * 60 * 1000);
      fs.utimesSync(lock, old, old);
      const winners = await race(dir, (i, go) => spawn(process.execPath, ['-e', `
        const fs = require('fs');
        const go = process.argv[1], lock = process.argv[2];
        // Resolve and compile the module BEFORE the start signal. Doing it after meant each
        // child paid a different module-load cost and they reached the acquire spread out
        // rather than together — which is why two reclaim mutants survived the first pass.
        import(process.argv[3]).then(({ acquireUpdateLock }) => {
          while (!fs.existsSync(go)) { /* spin */ }
          if (acquireUpdateLock(lock)) console.log('WIN');
        });
      `, go, lock, shared], { stdio: ['ignore', 'pipe', 'ignore'] }));
      assert.equal(winners, 1, `stale takeover admitted ${winners}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('will not delete a stale lock while somebody else is reclaiming it', async () => {
    /**
     * The serialisation, pinned directly rather than by racing.
     *
     * Eight processes released at once all reach the staleness check before any of them
     * deletes, so they take turns rather than overlapping and an unserialised reclaim looks
     * fine — verified: removing the guard left the concurrency tests above green. The
     * dangerous interleaving is one process sitting between "decided it was stale" and
     * "deleted it" while another finishes. Holding `.reclaim` is exactly that state, so
     * setting it up by hand reproduces the window deterministically.
     */
    const dir = tmpdir();
    try {
      const lock = path.join(dir, '.update-lock');
      const old = new Date(Date.now() - 20 * 60 * 1000);
      fs.writeFileSync(lock, '');
      fs.utimesSync(lock, old, old);
      fs.writeFileSync(lock + '.reclaim', '');   // another process is mid-reclaim, right now

      const { acquireUpdateLock } = await import(shared);
      assert.equal(acquireUpdateLock(lock), false,
        'took the lock out from under the process that is reclaiming it');
      assert.ok(fs.existsSync(lock),
        'deleted a lock somebody else was in the middle of handling');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('will not delete a lock that stopped being stale while it waited its turn', async () => {
    /**
     * The other half of the reclaim: winning the right to delete does not mean deleting is
     * still the right thing to do. Between deciding a lock was stale and getting a turn, the
     * process ahead may already have replaced it with a fresh one — deleting that is the
     * original bug with extra steps.
     *
     * Reproduced by a clock that stops reporting the lock as stale at the moment the
     * reclaim marker appears, which is exactly when the process ahead has finished. Driving
     * it off the file rather than a call counter keeps the test from depending on how many
     * times the implementation happens to read the time.
     */
    const dir = tmpdir();
    try {
      const lock = path.join(dir, '.update-lock');
      fs.writeFileSync(lock, '');   // fresh: this stands for the lock the winner just took
      const hourAhead = () => (fs.existsSync(lock + '.reclaim') ? Date.now() : Date.now() + 3600_000);

      const { acquireUpdateLock } = await import(shared);
      assert.equal(acquireUpdateLock(lock, { now: hourAhead }), false,
        'deleted a lock that was fresh by the time we got to look at it');
      assert.ok(fs.existsSync(lock), 'the fresh lock must survive');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a leaked reclaim marker does not let two processes into the critical section', async () => {
    /**
     * The gap all eight mutations missed, because every other reclaim test writes a *fresh*
     * marker. A `.reclaim` left behind by a killed reclaimer used to be cleared with
     * `stat` then `unlink` — check-then-act — so two processes could both clear it, the
     * second deleting the marker the first had just created. Both then sat inside the
     * section that deletes the real lock, and the winner of that could delete a fresh lock
     * somebody else legitimately held.
     *
     * Clearing is now a move-aside under a per-process name: whoever loses the move skips
     * the reclaim this round rather than racing for it.
     */
    const dir = tmpdir();
    try {
      const lock = path.join(dir, '.update-lock');
      const old = new Date(Date.now() - 20 * 60 * 1000);
      for (const f of [lock, lock + '.reclaim']) {
        fs.writeFileSync(f, '');
        fs.utimesSync(f, old, old);   // both stale: a reclaimer died mid-flight
      }
      const winners = await race(dir, (i, go) => spawn(process.execPath, ['-e', `
        const fs = require('fs');
        const go = process.argv[1], lock = process.argv[2];
        import(process.argv[3]).then(({ acquireUpdateLock }) => {
          while (!fs.existsSync(go)) { /* spin */ }
          if (acquireUpdateLock(lock)) console.log('WIN');
        });
      `, go, lock, shared], { stdio: ['ignore', 'pipe', 'ignore'] }));
      assert.ok(winners <= 1, `${winners} processes hold the same lock`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a process that loses the move-aside does not reclaim', async () => {
    // JS mirror. `renameSync` is made to throw, which is what losing the move looks like.
    const dir = tmpdir();
    try {
      const lock = path.join(dir, '.update-lock');
      const old = new Date(Date.now() - 20 * 60 * 1000);
      for (const p of [lock, lock + '.reclaim']) {
        fs.writeFileSync(p, 'held-by-somebody');
        fs.utimesSync(p, old, old);
      }
      const { acquireUpdateLock } = await import(shared);
      const realRename = fs.renameSync;
      fs.renameSync = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
      try {
        assert.equal(acquireUpdateLock(lock), false, 'reclaimed anyway after losing the move');
        assert.equal(fs.readFileSync(lock, 'utf8'), 'held-by-somebody',
          'deleted the stale lock despite losing the right to');
      } finally {
        fs.renameSync = realRename;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a displaced lock holder stands down', async () => {
    /**
     * Step three, pinned on its own. Whatever the first two steps miss, a process whose
     * lock was deleted and replaced must not go on believing it holds one — that is the
     * difference between a bounded race and two concurrent `git pull`s.
     *
     * Simulated by replacing the lock's contents the moment it is created: the token read
     * back is not the token written, which is exactly what displacement looks like.
     */
    const dir = tmpdir();
    try {
      const lock = path.join(dir, '.update-lock');
      const { acquireUpdateLock } = await import(shared);

      // Sanity: with nothing interfering it acquires. Without this the assertion below
      // passes just as well on an implementation that never acquires anything.
      assert.equal(acquireUpdateLock(lock), true, 'baseline acquire failed');
      fs.rmSync(lock);

      const realWriteSync = fs.writeSync;
      fs.writeSync = function patched(...args) {
        const r = realWriteSync.apply(this, args);
        try { fs.writeFileSync(lock, 'somebody-elses-token'); } catch { /* ignore */ }
        return r;
      };
      try {
        assert.equal(acquireUpdateLock(lock), false,
          'kept holding a lock whose contents are somebody else\'s');
      } finally {
        fs.writeSync = realWriteSync;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the shell and Node implementations agree on the staleness threshold', () => {
    // They guard the same file. If one calls a lock stale at 5 minutes and the other at 15,
    // the shorter one steals from a run that is still working.
    const js = fs.readFileSync(shared, 'utf8');
    assert.match(js, /5\s*\*\s*60\s*\*\s*1000/, 'the Node threshold is not 5 minutes');
    assert.match(src(), /-gt 300\b/, 'the shell threshold is not 300 seconds');
  });

  function src() { return fs.readFileSync(shellHook, 'utf8'); }
});
