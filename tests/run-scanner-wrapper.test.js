import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { makeBashScript, toBashPath, bashPathList } from './helpers/bash-script.js';

/**
 * End-to-end test for scripts/install-helpers/run-scanner.sh.
 *
 * Strategy: simulate the $HOME structure in a tmp dir → drop a fake node (a shell script that
 * prints stub messages) → run the wrapper → verify: candidate selection, version check,
 * error handling, and log behavior.
 */

const WRAPPER = path.resolve('scripts/install-helpers/run-scanner.sh');
const TMP_BASE = path.join(os.tmpdir(), `ownmind-wrapper-test-${process.pid}-${Date.now()}`);

async function makeHomeDir() {
  const home = path.join(TMP_BASE, `home-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(path.join(home, '.ownmind', 'hooks'), { recursive: true });
  await fs.mkdir(path.join(home, '.ownmind', 'logs'), { recursive: true });
  // Drop an empty scanner.js; the content does not matter since the stub node never really runs node
  await fs.writeFile(path.join(home, '.ownmind', 'hooks', 'ownmind-usage-scanner.js'),
    '// stub\n');
  return home;
}

async function writeStubNode(dirPath, { version = 'v22.5.0', exitCode = 0 } = {}) {
  const stub = path.join(dirPath, 'node');
  // Stub: --version returns the given version string; other args print "ran: ..." to stderr for verification
  await fs.writeFile(stub,
    `#!/bin/bash
if [ "\$1" = "--version" ]; then
  echo "${version}"
  exit 0
fi
echo "ran: $*" 1>&2
exit ${exitCode}
`, 'utf8');
  await fs.chmod(stub, 0o755);
  return stub;
}

async function writeStubNodePrintingEnv(dirPath, { version = 'v22.5.0' } = {}) {
  const stub = path.join(dirPath, 'node');
  // Prints its own PATH so a case can assert what the scanner's children would inherit.
  await fs.writeFile(stub,
    `#!/bin/bash
if [ "\$1" = "--version" ]; then
  echo "${version}"
  exit 0
fi
echo "child-path: \$PATH" 1>&2
exit 0
`, 'utf8');
  await fs.chmod(stub, 0o755);
  return stub;
}

function runWrapper(home, env = {}, { cwd = null } = {}) {
  // The wrapper's environment is exported by a launcher script rather than passed to spawn.
  // PATH is the reason: the cases restrict it to force the wrapper through .node-path, but
  // node reads the same variable to locate bash.exe and '/usr/bin:/bin' is not a path any
  // Windows process can be started from — every case died with `spawn bash ENOENT` before
  // the wrapper was reached. Exporting inside the launcher restricts exactly the lookups the
  // cases are about and leaves node's own alone.
  const wrapperEnv = {
    HOME: toBashPath(home),
    PATH: '/usr/bin:/bin',  // minimal PATH, forcing use of .node-path or PATH
    OWNMIND_DIR: toBashPath(path.join(home, '.ownmind')),
    OWNMIND_MIN_NODE_MAJOR: '20',
    OWNMIND_SKIP_SYSTEM_CANDIDATES: '1',  // disable real paths like /opt/homebrew during tests
    ...env
  };
  const launcher = makeBashScript([
    ...Object.entries(wrapperEnv).map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`),
    // A working directory matters only for the case that puts a relative path in
    // .node-path; everything else runs wherever the test runner happens to be.
    ...(cwd ? [`cd ${JSON.stringify(toBashPath(cwd))}`] : []),
    `exec bash ${JSON.stringify(toBashPath(WRAPPER))}`,
  ].join('\n'));

  return new Promise((resolve, reject) => {
    const child = spawn('bash', [launcher.file], {
      // Only what node needs to start bash. The wrapper sees wrapperEnv and nothing else,
      // because the launcher's exports overwrite anything inherited.
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => { launcher.cleanup(); reject(e); });
    child.on('close', (code) => {
      launcher.cleanup();
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8')
      });
    });
  });
}

beforeEach(async () => { await fs.mkdir(TMP_BASE, { recursive: true }); });
afterEach(async () => { try { await fs.rm(TMP_BASE, { recursive: true, force: true }); } catch {} });

describe('run-scanner.sh wrapper', () => {
  it('exits 1 + writes err log when no node found', async () => {
    const home = await makeHomeDir();
    const r = await runWrapper(home);
    assert.equal(r.code, 1);

    const errLog = await fs.readFile(path.join(home, '.ownmind/logs/scanner.err'), 'utf8');
    assert.match(errLog, /no node >= v20 found/);
  });

  it('exits 1 when node is too old', async () => {
    const home = await makeHomeDir();
    const binDir = path.join(home, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    await writeStubNode(binDir, { version: 'v18.17.0' });
    await fs.writeFile(path.join(home, '.ownmind/.node-path'), path.join(binDir, 'node'));

    const r = await runWrapper(home);
    assert.equal(r.code, 1);

    const errLog = await fs.readFile(path.join(home, '.ownmind/logs/scanner.err'), 'utf8');
    assert.match(errLog, /skip .*version=v18\.17\.0/);
  });

  it('uses .node-path cache when version OK + invokes scanner.js', async () => {
    const home = await makeHomeDir();
    const binDir = path.join(home, 'opt-node');
    await fs.mkdir(binDir, { recursive: true });
    const stubPath = await writeStubNode(binDir, { version: 'v22.5.0' });
    await fs.writeFile(path.join(home, '.ownmind/.node-path'), stubPath);

    const r = await runWrapper(home);
    assert.equal(r.code, 0);
    // when the stub node is invoked it prints "ran: <scanner-path>" to stderr
    assert.match(r.stderr, /ran: .+ownmind-usage-scanner\.js/);

    const outLog = await fs.readFile(path.join(home, '.ownmind/logs/scanner.log'), 'utf8');
    assert.match(outLog, /using node=/);
    assert.match(outLog, /version=v22\.5\.0/);
  });

  it('puts the chosen node directory on PATH so npm resolves for children', async () => {
    // A launchd agent gets PATH=/usr/bin:/bin:/usr/sbin:/sbin. `git` lives in /usr/bin so
    // the pull worked; node and npm are in /opt/homebrew/bin, so the auto-update's
    // `npm install` died with ENOENT every 30 minutes for 12 days, leaving the tree
    // advanced and scripts/update.sh — which copies the hooks into ~/.claude/hooks —
    // never run. The wrapper had to find node to start at all; npm is its neighbour.
    const home = await makeHomeDir();
    const binDir = path.join(home, 'opt-node');
    await fs.mkdir(binDir, { recursive: true });
    const stubPath = await writeStubNodePrintingEnv(binDir, { version: 'v22.5.0' });
    // A bash-style path: `dirname` on a backslash-separated one answers ".", which the
    // wrapper refuses to put on PATH, so a native path here would test nothing on Windows.
    await fs.writeFile(path.join(home, '.ownmind/.node-path'), toBashPath(stubPath));

    const r = await runWrapper(home);
    assert.equal(r.code, 0);
    const printed = /child-path: (.*)/.exec(r.stderr);
    assert.ok(printed, `stub node did not print its PATH: ${r.stderr}`);
    // Substring rather than a split on the separator: on Windows the wrapper reads a native
    // path out of .node-path, and a drive letter's colon makes ':' the wrong separator and
    // ';' the wrong one for the bash-style PATH the launcher exports.
    assert.ok(
      printed[1].includes(toBashPath(binDir)) || printed[1].includes(binDir),
      `node's own directory must be on PATH for npm to resolve; got ${printed[1]}`
    );
  });

  it('never prepends a relative directory to PATH', async () => {
    // dirname answers a relative directory for a relative .node-path, and "." for the
    // backslash path that scripts/windows/register-scanner-task.ps1 writes into that same
    // file. Either one on PATH means "run whatever is in the working directory".
    const home = await makeHomeDir();
    const binDir = path.join(home, 'rel-node');
    await fs.mkdir(binDir, { recursive: true });
    await writeStubNodePrintingEnv(binDir, { version: 'v22.5.0' });
    await fs.writeFile(path.join(home, '.ownmind/.node-path'), 'rel-node/node');

    const r = await runWrapper(home, {}, { cwd: home });
    assert.equal(r.code, 0);
    const outLog = await fs.readFile(path.join(home, '.ownmind/logs/scanner.log'), 'utf8');
    assert.match(outLog, /using node=rel-node\/node/);
    const printed = /child-path: (.*)/.exec(r.stderr);
    assert.ok(printed, `stub node did not print its PATH: ${r.stderr}`);
    assert.equal(printed[1], '/usr/bin:/bin',
      `a relative directory must never reach PATH; got ${printed[1]}`);
  });

  it('falls back to PATH node when .node-path missing', async () => {
    const home = await makeHomeDir();
    const pathDir = path.join(home, 'path-node');
    await fs.mkdir(pathDir, { recursive: true });
    await writeStubNode(pathDir, { version: 'v20.11.0' });
    // do not create .node-path; rely on PATH to provide it
    // bashPathList: a raw Windows path prepended here is split at its drive colon and the
    // remainder is resolved against the current drive, so the stub was invisible whenever
    // the checkout and the temp directory were on different drives — which is exactly the
    // CI Windows runner (`D:` checkout, `C:` temp) and not a developer box.
    const r = await runWrapper(home, { PATH: `${bashPathList(pathDir)}:/usr/bin:/bin` });
    assert.equal(r.code, 0);
    const outLog = await fs.readFile(path.join(home, '.ownmind/logs/scanner.log'), 'utf8');
    assert.match(outLog, /version=v20\.11\.0/);
  });

  it('falls back to homebrew candidate when .node-path and PATH both fail', async () => {
    const home = await makeHomeDir();
    // Build an /opt/homebrew-like fake path via $HOME/opt/homebrew/bin
    // but the wrapper's hardcoded path is the real /opt/homebrew/bin —
    // we cannot perfectly simulate without sudo; this test only verifies "candidate ordering prefers .node-path"
    const hbBin = path.join(home, 'my-opt/node');
    await fs.mkdir(path.dirname(hbBin), { recursive: true });
    await writeStubNode(path.dirname(hbBin), { version: 'v20.0.0' });
    // put my-opt into PATH
    const r = await runWrapper(home, { PATH: `${bashPathList(path.dirname(hbBin))}:/usr/bin:/bin` });
    assert.equal(r.code, 0);
  });

  it('exits 2 when scanner.js missing', async () => {
    const home = path.join(TMP_BASE, `home-missing-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(home, '.ownmind', 'logs'), { recursive: true });
    const binDir = path.join(home, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    const stubPath = await writeStubNode(binDir, { version: 'v22.0.0' });
    await fs.writeFile(path.join(home, '.ownmind/.node-path'), stubPath);

    const r = await runWrapper(home);
    assert.equal(r.code, 2);
    const errLog = await fs.readFile(path.join(home, '.ownmind/logs/scanner.err'), 'utf8');
    assert.match(errLog, /scanner entry not found/);
  });

  it('runtime opt-out flag exits 0 without even looking for node', async () => {
    const home = await makeHomeDir();
    // create the opt-out flag; no stub node → if it actually ran it would exit 1 for missing node
    await fs.writeFile(path.join(home, '.ownmind', '.no-usage-scanner'), '');
    const r = await runWrapper(home);
    assert.equal(r.code, 0, 'opt-out 應該 exit 0，完全 bypass');
    const outLog = await fs.readFile(path.join(home, '.ownmind/logs/scanner.log'), 'utf8');
    assert.match(outLog, /opt-out flag present, skipping/);
  });

  it('respects OWNMIND_MIN_NODE_MAJOR override (=22)', async () => {
    const home = await makeHomeDir();
    const binDir = path.join(home, 'opt-node');
    await fs.mkdir(binDir, { recursive: true });
    const stubPath = await writeStubNode(binDir, { version: 'v20.11.0' });
    await fs.writeFile(path.join(home, '.ownmind/.node-path'), stubPath);

    const r = await runWrapper(home, { OWNMIND_MIN_NODE_MAJOR: '22' });
    assert.equal(r.code, 1, '設 min=22 → v20.11 不合格');
    const errLog = await fs.readFile(path.join(home, '.ownmind/logs/scanner.err'), 'utf8');
    assert.match(errLog, /skip .*version=v20\.11\.0 < v22/);
  });
});
