import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * v1.26.114 — a test run that hangs must say which test it is stuck in.
 *
 * On 2026-08-09, the first day this repo had CI, the macOS leg stopped producing output
 * partway through the suite and stayed that way until `timeout-minutes` killed it: twenty
 * minutes, not one further line, and a job conclusion of `cancelled` — which reads like
 * somebody pressed a button rather than like a defect. The same commit passed on a re-run,
 * so there was nothing left to go back and look at.
 *
 * `node --test` has no deadline by default, so a hang is unbounded and silent.
 * `--test-timeout` bounds it and — this is the part that matters — names what it gave up on.
 * That turns "the job went quiet" into a line somebody can act on.
 *
 * Two shapes of hang exist, and which of them actually hangs depends on the node version:
 *
 *   - a test that never settles: node 24 waits for it, node 20 notices the event loop has
 *     drained and fails it in two milliseconds;
 *   - a file whose tests all pass but which leaves a handle open: both wait for it, and on
 *     node 24 the flag does not end that one either.
 *
 * So this does not hard-code either version's behaviour. It measures, on whichever node is
 * running it, which shapes hang; requires at least one to (otherwise the check below is
 * measuring nothing); and requires the deadline to end and name at least one of them.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'test.yml');

/** The deadline handed to the probes. Short, because the probes exist to hit it. */
const PROBE_TIMEOUT_MS = 500;

/** How long a probe has to still be running before it counts as hung. */
const HANG_EVIDENCE_MS = PROBE_TIMEOUT_MS * 3;

/** Long enough for a bounded probe to report, short enough that a broken flag fails fast. */
const PROBE_BUDGET_MS = 5_000;

const SHAPES = [
  {
    label: 'a test that never settles',
    // What the report has to come back with: the test's own name.
    identify: () => 'sits there forever',
    body: [
      "import { it } from 'node:test';",
      "it('sits there forever', async () => { await new Promise(() => {}); });",
      '',
    ].join('\n'),
  },
  {
    label: 'a file whose tests pass but which never exits',
    // Nothing inside the file is stuck, so the file's own path is what has to come back —
    // the whole path, not the basename every line of its output would carry anyway.
    identify: (file) => file,
    body: [
      "import { it } from 'node:test';",
      "import net from 'node:net';",
      "it('passes, then keeps the process alive', () => { net.createServer().listen(0); });",
      '',
    ].join('\n'),
  },
];

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-hang-'));
}

/**
 * The environment for a nested `node --test`.
 *
 * `NODE_TEST_CONTEXT` is set in every file the runner executes, and a runner that finds it
 * in its own environment prints "run() is being called recursively within a test file.
 * skipping running files" and exits 0 without running anything. Inherit it and every probe
 * here passes in 200ms while measuring nothing at all.
 */
function envWithoutTestContext() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function writeProbe(dir, body) {
  const file = path.join(dir, 'probe.test.js');
  fs.writeFileSync(file, body);
  return file;
}

/** How long to wait for a killed probe before giving up on seeing it exit. */
const REAP_TIMEOUT_MS = 5_000;

/**
 * Remove a probe directory.
 *
 * Retried, because Windows refuses to remove a directory any process still holds — and a
 * process the kernel has already reaped can keep its handles for a moment longer. This is
 * what failed on the Windows leg: `EBUSY: resource busy or locked, rmdir`.
 */
function removeProbeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

/**
 * Kill a probe and everything it started, then wait for it to actually be gone.
 *
 * Signalling the runner alone is not enough on posix: it executes each file in a grandchild
 * process, and SIGKILL is not forwarded. Measured — killing only the runner left
 * `node probe.test.js` alive, reparented to init, still holding its listening socket. So the
 * probes are spawned detached and the whole group is signalled.
 *
 * Windows has neither process groups nor negative pids: `process.kill(-pid)` throws there,
 * and the fallback is `child.kill()`, which terminates the tree anyway. Either way this must
 * not resolve before the process is gone — returning early is what left a live process
 * holding the directory the caller then tried to delete.
 */
function killGroup(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.once('exit', finish);
    child.once('error', finish);          // never started: there is nothing to wait for
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // EPERM/EINVAL on Windows, ESRCH when it is already gone. Signal the child itself and
      // keep waiting for the exit event either way.
      try { child.kill('SIGKILL'); } catch { finish(); }
    }
    // A process that refuses to die must not hang the suite; the retrying remove below is
    // what covers the directory in that case.
    setTimeout(finish, REAP_TIMEOUT_MS).unref?.();
  });
}

/** @returns {Promise<boolean>} whether the shape is still running well past the deadline. */
async function hangsWithoutTheFlag(shape) {
  const dir = tmpdir();
  let child;
  try {
    const file = writeProbe(dir, shape.body);
    // cwd is deliberately not the probe directory: on Windows a directory cannot be removed
    // while any process has it as its working directory, and the file is passed absolute.
    child = spawn(process.execPath, ['--test', file],
      { cwd: os.tmpdir(), stdio: 'ignore', env: envWithoutTestContext(), detached: true });
    let ended = false;
    // Without this listener an EAGAIN/EMFILE under fork pressure raises an unhandled
    // 'error' event, which takes down the whole test process instead of one assertion.
    child.on('error', () => { ended = true; });
    const exited = new Promise((r) => child.once('exit', () => { ended = true; r(); }));
    const waited = new Promise((r) => setTimeout(r, HANG_EVIDENCE_MS));
    // Resolves as soon as it ends, so a shape that does not hang costs almost nothing.
    await Promise.race([exited, waited]);
    return !ended;
  } finally {
    await killGroup(child);
    removeProbeDir(dir);
  }
}

/** @returns {{ended: boolean, named: boolean, output: string}} what the deadline did to it. */
function runUnderTheFlag(shape) {
  const dir = tmpdir();
  try {
    const file = writeProbe(dir, shape.body);
    const r = spawnSync(
      process.execPath,
      [`--test-timeout=${PROBE_TIMEOUT_MS}`, '--test', file],
      // cwd: see hangsWithoutTheFlag — never the directory this function then removes.
      { encoding: 'utf8', timeout: PROBE_BUDGET_MS, cwd: os.tmpdir(), env: envWithoutTestContext() },
    );
    const output = `${r.stdout || ''}${r.stderr || ''}`;
    // `error` covers both ways this ends without the deadline having done anything: the
    // budget above running out (ETIMEDOUT — and the runner handles SIGTERM, so it exits 1
    // with no signal, which would otherwise read as a clean failure) and the binary not
    // being there at all (ENOENT, status null).
    const ended = !r.signal && !r.error && r.status !== 0;
    // Matched on the name and the reason rather than on a TAP line: node 20 prints TAP when
    // stdout is a pipe, node 24 prints the spec reporter, and what matters is that the name
    // reaches whoever is reading the log — not which of the two shapes it arrives in.
    const named = output.includes(shape.identify(file)) && /timed out after/.test(output);
    return { ended, named, output };
  } finally {
    removeProbeDir(dir);
  }
}

/** Every `npm` script that runs the test runner, so a new one cannot be added without one. */
function scriptsThatRunTheRunner() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  return Object.entries(pkg.scripts).filter(([, cmd]) => /\bnode .*--test\b/.test(cmd));
}

/** The tightest `timeout-minutes` in the workflow, in ms — the wall a deadline must beat. */
function jobCapMs() {
  const caps = [...fs.readFileSync(WORKFLOW, 'utf8').matchAll(/timeout-minutes:\s*(\d+)/g)]
    .map((m) => Number(m[1]) * 60_000);
  assert.ok(caps.length > 0, `${WORKFLOW} declares no timeout-minutes to measure against`);
  return Math.min(...caps);
}

describe('v1.26.114 — a hung run names what it is stuck on', () => {
  it('every script that runs the runner carries a deadline', () => {
    const scripts = scriptsThatRunTheRunner();
    assert.ok(scripts.length > 0, 'no npm script runs node --test — did the wording change?');
    const missing = scripts.filter(([, cmd]) => !/--test-timeout=\d+/.test(cmd));
    assert.deepEqual(missing.map(([name]) => name), [],
      'these run the suite with no deadline, so a stuck file hangs the whole job in silence');
  });

  it('the deadline fires early enough to matter and late enough to be safe', () => {
    const cap = jobCapMs();
    for (const [name, cmd] of scriptsThatRunTheRunner()) {
      const ms = Number(cmd.match(/--test-timeout=(\d+)/)[1]);
      // Below: the whole suite runs in well under a minute on every CI platform, and a
      // deadline near that turns a slow runner into a red build — worse than the hang it is
      // meant to catch.
      assert.ok(ms >= 60_000, `${name}: ${ms}ms is close enough to a normal run to fire on a slow runner`);
      // Above: a deadline that cannot fire before the job's own limit gives back exactly the
      // silence this exists to remove. Half the cap, so there is room to report afterwards.
      assert.ok(ms <= cap / 2,
        `${name}: ${ms}ms leaves no room inside the job's ${cap}ms limit — the job would be `
        + 'killed first, which is the twenty minutes of silence this was added to end');
    }
  });

  it('the deadline ends a hang that would otherwise be unbounded, and says which one', async () => {
    // One shape at a time, and each one's reverse check comes first: without it, everything
    // below would still pass on a node that ended the probe for some unrelated reason, and
    // the deadline would be credited with something it did not do.
    let anyHung = false;
    const tried = [];
    for (const shape of SHAPES) {
      if (!await hangsWithoutTheFlag(shape)) continue;
      anyHung = true;
      const result = { shape, ...runUnderTheFlag(shape) };
      tried.push(result);
      if (result.ended && result.named) return;   // one demonstrated hang is the requirement
    }
    assert.ok(anyHung, `neither shape hangs on ${process.version}, so this check measures nothing`);
    assert.fail(
      `the deadline ended and named none of the ${tried.length} shape(s) that hang on `
      + `${process.version}:\n`
      + tried.map((r) => `— ${r.shape.label}: ended=${r.ended} named=${r.named}`).join('\n'));
  });
});
