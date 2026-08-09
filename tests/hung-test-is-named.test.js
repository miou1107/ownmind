import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * v1.26.112 — a test run that hangs must say which test it is stuck in.
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

/** The deadline handed to the probes. Short, because the probes exist to hit it. */
const PROBE_TIMEOUT_MS = 500;

/** How long a probe has to still be running before it counts as hung. */
const HANG_EVIDENCE_MS = PROBE_TIMEOUT_MS * 3;

/** Long enough for a bounded probe to report, short enough that a broken flag fails fast. */
const PROBE_BUDGET_MS = 5_000;

const SHAPES = [
  {
    label: 'a test that never settles',
    // The name below is what the report has to come back with.
    identifier: 'sits there forever',
    body: [
      "import { it } from 'node:test';",
      "it('sits there forever', async () => { await new Promise(() => {}); });",
      '',
    ].join('\n'),
  },
  {
    label: 'a file whose tests pass but which never exits',
    identifier: 'probe.test.js',
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

/** @returns {Promise<boolean>} whether the shape is still running well past the deadline. */
async function hangsWithoutTheFlag(shape) {
  const dir = tmpdir();
  let child;
  try {
    const file = writeProbe(dir, shape.body);
    child = spawn(process.execPath, ['--test', file],
      { cwd: dir, stdio: 'ignore', env: envWithoutTestContext() });
    let exited = false;
    child.on('exit', () => { exited = true; });
    await new Promise((r) => setTimeout(r, HANG_EVIDENCE_MS));
    return !exited;
  } finally {
    if (child) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
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
      { encoding: 'utf8', timeout: PROBE_BUDGET_MS, cwd: dir, env: envWithoutTestContext() },
    );
    const output = `${r.stdout || ''}${r.stderr || ''}`;
    // `signal` is set when the budget above had to kill it, which is the deadline failing.
    const ended = !r.signal && r.status !== 0;
    // Matched on the name and the reason rather than on a TAP line: node 20 prints TAP when
    // stdout is a pipe, node 24 prints the spec reporter, and what matters is that the name
    // reaches whoever is reading the log — not which of the two shapes it arrives in.
    const named = output.includes(shape.identifier) && /timed out after/.test(output);
    return { ended, named, output };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('v1.26.112 — a hung run names what it is stuck on', () => {
  it('the test script carries a deadline', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    const script = pkg.scripts.test;
    assert.match(script, /--test-timeout=\d+/,
      `npm test has no deadline, so a stuck file hangs the whole job in silence: ${script}`);
    const ms = Number(script.match(/--test-timeout=(\d+)/)[1]);
    // The whole suite runs in well under a minute on every CI platform. A deadline anywhere
    // near that would turn a slow runner into a red build, which is worse than the hang it
    // is meant to catch — so it sits far above the suite, not near a single test.
    assert.ok(ms >= 60_000, `${ms}ms is close enough to a normal run to fire on a slow runner`);
  });

  it('the deadline ends a hang that would otherwise be unbounded, and says which one', async () => {
    // Reverse check first: without it, everything below would still pass on a node that
    // ended these probes for some unrelated reason, and the deadline would be credited with
    // something it did not do.
    const hanging = [];
    for (const shape of SHAPES) {
      if (await hangsWithoutTheFlag(shape)) hanging.push(shape);
    }
    assert.ok(hanging.length > 0,
      `neither shape hangs on ${process.version}, so this check measures nothing`);

    // Stops at the first shape the deadline handles: on node 24 that is the first one, and
    // running the second costs the whole budget for a result already known to be redundant.
    const results = [];
    for (const shape of hanging) {
      results.push({ shape, ...runUnderTheFlag(shape) });
      if (results[results.length - 1].ended && results[results.length - 1].named) break;
    }
    const bounded = results.filter((r) => r.ended && r.named);
    assert.ok(bounded.length > 0,
      `the deadline ended and named none of the ${hanging.length} shape(s) that hang on `
      + `${process.version}:\n`
      + results.map((r) => `— ${r.shape.label}: ended=${r.ended} named=${r.named}`).join('\n'));
  });
});
