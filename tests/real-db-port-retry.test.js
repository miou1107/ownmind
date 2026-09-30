import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REAL_DB_SPECIFIER = JSON.stringify(
  pathToFileURL(path.join(repoRoot, 'tests', 'helpers', 'real-db.js')).href,
);

/**
 * What the helper does when the port it derived is already bound.
 *
 * The port comes from this process's pid, and the container is named after the port. A test
 * process that died without its `stop()` leaves a container still publishing that port under
 * a name derived from the DEAD pid, so the `docker rm -f <own name>` at startup cannot match
 * it: the run then fails with `address already in use` and takes the whole leg red. That is
 * what happened to the ubuntu/node 24 leg of run 36527943229 — a dependency bump, nothing
 * near the database, and a rerun of the same commit was green.
 *
 * Every case drives the real helper with `docker` replaced by a stub on PATH, so no image is
 * pulled and no container is started.
 */

/**
 * A directory holding a fake `docker` that writes every call it receives to `callLog`.
 *
 * `run` behaves as `mode` says:
 *   `bind-first`  — the FIRST port it is asked for is refused the way a bound one is, any
 *                   other accepted. The refused port is whichever the helper picked first,
 *                   recorded by the stub, so a case does not have to predict a pid-derived
 *                   number.
 *   `no-image`    — every run fails the way a pull does, on every port.
 *   `never-ready` — every run succeeds, the readiness probe never does, and `docker logs`
 *                   carries postgres's own `Address already in use` from initdb.
 *
 * `ps` prints `psOutput`, so a case decides whether there is a leftover of ours to reclaim.
 */
function stubDockerBin({ mode, callLog, firstPortFile, psOutput = '' }) {
  const dir = tempDir('stub-docker-port-');
  const runBody = {
    'bind-first': `
    if [ -f ${JSON.stringify(firstPortFile)} ]; then first=$(cat ${JSON.stringify(firstPortFile)});
    else printf %s "$port" > ${JSON.stringify(firstPortFile)}; first="$port"; fi
    if [ "$port" = "$first" ]; then
      echo "docker: Error response from daemon: failed to bind host port for 0.0.0.0:$port: address already in use" >&2
      exit 125
    fi
    exit 0;;`,
    'no-image': `
    echo "docker: Error response from daemon: pull access denied for pgvector/pgvector" >&2
    exit 125;;`,
    'never-ready': `
    exit 0;;`,
  }[mode];

  const script = `#!/bin/sh
echo "$@" >> ${JSON.stringify(callLog)}
case "$1" in
  info) exit 0;;
  ps) ${psOutput ? `echo ${JSON.stringify(psOutput)}` : 'true'}; exit 0;;
  exec) ${mode === 'never-ready' ? 'echo "database system is starting up" >&2; exit 2' : 'exit 0'};;
  logs) echo 'could not bind IPv4 address "0.0.0.0": Address already in use' >&2; exit 0;;
  run)
    port=""
    for a in "$@"; do
      case "$a" in *:5432) port="\${a%%:*}";; esac
    done${runBody}
  *) exit 0;; esac
`;
  fs.writeFileSync(path.join(dir, 'docker'), script, { mode: 0o755 });
  return dir;
}

/** Run one snippet in its own node process, with a private lock dir and the stub on PATH. */
function runInProcess({ tmpdir, dockerBin, code, env = {} }) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      TMPDIR: tmpdir,
      TEMP: tmpdir,
      TMP: tmpdir,
      PATH: `${dockerBin}${path.delimiter}${process.env.PATH}`,
    },
  });
}

/** The lines of the stub's log that are `docker run …`, in order. */
function runCalls(callLog) {
  return fs.readFileSync(callLog, 'utf8').trim().split('\n').filter((l) => l.startsWith('run '));
}

/** The port `docker run` was asked to publish, from one line of the stub's log. */
function portOf(runCall) {
  return (runCall.match(/(\d+):5432/) || [])[1];
}

/** Start a database with the stub standing in for docker, and report what came back. */
const START_AND_REPORT = (options = '') => `
  const { startRealDb } = await import(${REAL_DB_SPECIFIER});
  try {
    const db = await startRealDb(${options});
    // A null db means the stub was never found and startRealDb declared docker unavailable,
    // which is a different fact from the helper having started a database.
    console.log(JSON.stringify(db ? { port: db.port, name: db.name } : 'NO_DOCKER'));
  } catch (err) { console.log(JSON.stringify({ error: String(err && err.message) })); }
  process.exit(0);
`;

/**
 * Skipped on Windows for the fixture's sake, not the helper's: `execFileSync('docker', …)`
 * resolves to `docker.cmd` there and cannot launch a batch file without a shell, so the stub
 * never stands in and the case would measure the machine instead of the message.
 */
const SKIP_ON_WINDOWS = process.platform === 'win32'
  ? 'the docker stub cannot run on Windows: execFileSync cannot launch a .cmd stub'
  : false;

test('a bound port sends the helper to another port instead of failing the leg', { skip: SKIP_ON_WINDOWS }, async () => {
  const logDir = tempDir('port-retry-log-');
  const callLog = path.join(logDir, 'calls.txt');
  const dockerBin = stubDockerBin({
    mode: 'bind-first', callLog, firstPortFile: path.join(logDir, 'first.txt'),
  });

  const out = runInProcess({
    tmpdir: tempDir('port-retry-'), dockerBin, code: START_AND_REPORT(),
  });

  const result = JSON.parse(out.trim());
  assert.ok(result && result.port,
    `the helper must come back with a database, not ${JSON.stringify(result)} — a port held by `
    + 'something else is not a reason to fail the run');

  const runs = runCalls(callLog);
  assert.ok(runs.length >= 2,
    'it must actually have asked docker for a second port; one attempt means the retry never ran');
  assert.notEqual(String(result.port), portOf(runs[0]),
    'and the database it hands back must be on the port that worked, not the bound one');
  assert.equal(String(result.port), portOf(runs[runs.length - 1]),
    'the port in the returned handle is the one docker accepted, or a caller connects nowhere');
  assert.match(String(result.name), new RegExp(`${result.port}$`),
    'the container name follows the port it ended up on, so `docker rm -f <name>` still matches it');
});

test('a failure another port cannot fix is reported on the first attempt', { skip: SKIP_ON_WINDOWS }, async () => {
  const callLog = path.join(tempDir('no-image-log-'), 'calls.txt');
  const dockerBin = stubDockerBin({ mode: 'no-image', callLog });

  const out = runInProcess({
    tmpdir: tempDir('no-image-'), dockerBin, code: START_AND_REPORT(),
  });

  const result = JSON.parse(out.trim());
  assert.match(String(result.error || ''), /pull access denied/,
    'docker\'s own reason must survive: a pull that will not happen is not a port problem');
  assert.equal(runCalls(callLog).length, 1,
    'and it must be tried once — five identical failures cost the reader the cause and four '
    + 'image pulls');
});

test('a port the caller named is used once, and its failure is the answer', { skip: SKIP_ON_WINDOWS }, async () => {
  const logDir = tempDir('pinned-log-');
  const callLog = path.join(logDir, 'calls.txt');
  const dockerBin = stubDockerBin({
    mode: 'bind-first', callLog, firstPortFile: path.join(logDir, 'first.txt'),
  });

  const out = runInProcess({
    tmpdir: tempDir('pinned-'), dockerBin, code: START_AND_REPORT('{ port: 55999 }'),
  });

  const result = JSON.parse(out.trim());
  assert.match(String(result.error || ''), /address already in use/,
    'a caller who named a port is demonstrating that port; wandering off it hides what they '
    + 'were showing');
  const runs = runCalls(callLog);
  assert.equal(runs.length, 1, 'so exactly one attempt');
  assert.equal(portOf(runs[0]), '55999', 'on the port they named');
});

test('a postgres that dies saying "Address already in use" is not retried', { skip: SKIP_ON_WINDOWS }, async () => {
  const callLog = path.join(tempDir('never-ready-log-'), 'calls.txt');
  const dockerBin = stubDockerBin({ mode: 'never-ready', callLog });

  const out = runInProcess({
    tmpdir: tempDir('never-ready-'),
    dockerBin,
    // Two probes rather than forty: the case is about how many containers get started, and
    // forty one-second waits would buy the same assertion four times over.
    env: { OWNMIND_TEST_DB_READY_ATTEMPTS: '2' },
    code: START_AND_REPORT(),
  });

  const result = JSON.parse(out.trim());
  assert.match(String(result.error || ''), /never became ready/,
    'the container started and then never answered, which is what the reader must be told');
  // The readiness path releases the lock on its way out. Retrying after it would run the
  // remaining attempts unguarded — two postgres containers at once is the exact thing the
  // lock was added to prevent — and postgres's own initdb log is what makes that tempting:
  // it says `Address already in use` too.
  assert.equal(runCalls(callLog).length, 1,
    'so it must not go round again: the lock is already gone by then');
});

test('a leftover container of ours on that port is the one removed', { skip: SKIP_ON_WINDOWS }, async () => {
  const callLog = path.join(tempDir('reclaim-log-'), 'calls.txt');
  const dockerBin = stubDockerBin({ mode: 'no-image', callLog, psOutput: 'ownmind-test-db-99999' });

  const out = runInProcess({
    tmpdir: tempDir('reclaim-'),
    dockerBin,
    code: `
      const { reclaimAbandonedContainersOn } = await import(${REAL_DB_SPECIFIER});
      console.log(JSON.stringify(reclaimAbandonedContainersOn(55123)));
      process.exit(0);
    `,
  });

  assert.deepEqual(JSON.parse(out.trim()), ['ownmind-test-db-99999'],
    'the helper must report which of our leftovers it removed — a reclaim nobody can see is '
    + 'indistinguishable from the port never having been held');

  const calls = fs.readFileSync(callLog, 'utf8').trim().split('\n');
  const ps = calls.find((l) => l.startsWith('ps '));
  assert.match(ps, /publish=55123/,
    'it must ask by published host port: the container name cannot answer this, which is the '
    + 'whole reason the orphan survived');
  assert.match(ps, /name=\^ownmind-test-db-/,
    'anchored, because docker matches names as substrings and `unrelated-ownmind-test-db-1` '
    + 'belongs to someone else');
  assert.ok(!/(^| )-a( |$)/.test(ps),
    'and only running containers: a stopped one holds no port, so removing it just throws '
    + 'away somebody\'s evidence');
  assert.ok(calls.includes('rm -f ownmind-test-db-99999'),
    'the container docker named is the one that gets removed');
});
