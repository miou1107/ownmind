import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REAL_DB_SPECIFIER = JSON.stringify(
  pathToFileURL(path.join(repoRoot, 'tests', 'helpers', 'real-db.js')).href,
);

/**
 * What a failed `docker run` tells the person reading a red CI leg.
 *
 * The ubuntu leg of PR run 35604459374 failed with the command line and nothing else:
 * `Command failed: docker run -d --name ownmind-test-db-55146 …`. A port already bound, an
 * image that will not pull, a daemon out of disk and a rate-limited registry all produce that
 * identical line, so the message narrows the cause to nothing. docker's own explanation was
 * thrown away by `stdio: 'ignore'` at the call site.
 *
 * Both cases drive the real helper with `docker` replaced by a stub on PATH, so nothing is
 * pulled and no container is started.
 */

/**
 * A directory holding a fake `docker` whose `run` (or readiness probe) fails with a message
 * only the stub could have produced, so an assertion on it cannot pass by accident.
 */
function stubDockerBin(behaviour, probeLog) {
  const dir = tempDir('stub-docker-detail-');
  const script = behaviour === 'run-fails'
    // `info` succeeds so startRealDb gets past its availability check; `run` then fails the
    // way a bound port does, with the daemon's reason on stderr. The port in that sentence is
    // the one from the CI run this case comes from, not the one this run will pick — the
    // assertion is on the stub's own literal, so it cannot pass by accident.
    ? '#!/bin/sh\ncase "$1" in\n  info) exit 0;;\n  run) echo "Error response from daemon: '
      + 'port 55146 is already allocated" >&2; exit 125;;\n  *) exit 0;; esac\n'
    // The container starts and then never answers: `exec` fails the way a postgres that died
    // during initdb does, and `logs` carries the reason. Each probe leaves a line behind, so
    // the case can count them rather than infer them from how long it took.
    //
    // The log deliberately straddles both streams. docker sends a container's stdout to ours
    // and its stderr to ours, postgres writes its startup log to stderr, and a helper reading
    // only stdout returns an empty string for exactly the failure worth reporting. Split this
    // way, dropping either half of the read turns this case red.
    : '#!/bin/sh\ncase "$1" in\n  info) exit 0;;\n'
      + `  exec) echo x >> ${JSON.stringify(probeLog)}; echo "database system is shutting `
      + 'down" >&2; exit 2;;\n'
      + '  logs) echo "PostgreSQL init process failed"; echo "initdb: error: directory not '
      + 'empty" >&2; exit 0;;\n'
      + '  *) exit 0;; esac\n';
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

/**
 * Skipped on Windows for the fixture's sake, not the helper's: `execFileSync('docker', …)`
 * resolves to `docker.cmd` there and cannot launch a batch file without a shell, so the stub
 * never stands in and the case would measure the machine instead of the message.
 */
const SKIP_ON_WINDOWS = process.platform === 'win32'
  ? 'the docker stub cannot run on Windows: execFileSync cannot launch a .cmd stub'
  : false;

test('a container that will not start reports the daemon\'s reason', { skip: SKIP_ON_WINDOWS }, async () => {
  const dockerBin = stubDockerBin('run-fails');
  const out = runInProcess({
    tmpdir: tempDir('detail-run-'),
    dockerBin,
    code: `
      const { startRealDb } = await import(${REAL_DB_SPECIFIER});
      try {
        const db = await startRealDb();
        // A null db means the stub was never found and startRealDb declared docker
        // unavailable, which is a different fact from the helper having started a database.
        console.log(db ? 'UNEXPECTED_SUCCESS' : 'NO_DOCKER');
      } catch (err) { console.log(JSON.stringify(String(err && err.message))); }
      process.exit(0);
    `,
  });
  const message = JSON.parse(out.trim());
  assert.match(message, /port 55146 is already allocated/,
    'the reason docker gave must survive into the error a reader sees — without it, a bound '
    + 'port, a failed pull and a full disk are the same line');
});

test('a container that never answers reports the probe and the container log', { skip: SKIP_ON_WINDOWS }, async () => {
  const probeLog = path.join(tempDir('detail-probes-'), 'probes.txt');
  const dockerBin = stubDockerBin('never-ready', probeLog);
  const out = runInProcess({
    tmpdir: tempDir('detail-ready-'),
    dockerBin,
    // Two attempts rather than forty: the case is what the throw says, and forty one-second
    // waits would buy the same assertion for another thirty-eight seconds.
    env: { OWNMIND_TEST_DB_READY_ATTEMPTS: '2' },
    code: `
      const { startRealDb } = await import(${REAL_DB_SPECIFIER});
      try {
        const db = await startRealDb();
        // A null db means the stub was never found and startRealDb declared docker
        // unavailable, which is a different fact from the helper having started a database.
        console.log(db ? 'UNEXPECTED_SUCCESS' : 'NO_DOCKER');
      } catch (err) { console.log(JSON.stringify(String(err && err.message))); }
      process.exit(0);
    `,
  });
  const message = JSON.parse(out.trim());
  assert.match(message, /database system is shutting down/,
    'the last probe failure must be in the throw: "never became ready" alone cannot tell a '
    + 'dead postgres from a slow one');
  assert.match(message, /initdb: error: directory not empty/,
    'and the container log with it — that is where a postgres that died during startup says why');
  assert.match(message, /PostgreSQL init process failed/,
    'from both of docker\'s streams: a helper reading stdout alone loses the half postgres '
    + 'writes to stderr, and reading stderr alone loses this half');
  assert.equal(fs.readFileSync(probeLog, 'utf8').trim().split('\n').length, 2,
    'and the attempt count must be the one the case asked for — if the override silently '
    + 'stopped working this would still pass, it would just take forty seconds');
});
