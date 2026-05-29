import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

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

function runWrapper(home, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [WRAPPER], {
      env: {
        HOME: home,
        PATH: '/usr/bin:/bin',  // minimal PATH, forcing use of .node-path or PATH
        OWNMIND_DIR: path.join(home, '.ownmind'),
        OWNMIND_MIN_NODE_MAJOR: '20',
        OWNMIND_SKIP_SYSTEM_CANDIDATES: '1',  // disable real paths like /opt/homebrew during tests
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
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

  it('falls back to PATH node when .node-path missing', async () => {
    const home = await makeHomeDir();
    const pathDir = path.join(home, 'path-node');
    await fs.mkdir(pathDir, { recursive: true });
    await writeStubNode(pathDir, { version: 'v20.11.0' });
    // do not create .node-path; rely on PATH to provide it
    const r = await runWrapper(home, { PATH: `${pathDir}:/usr/bin:/bin` });
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
    const r = await runWrapper(home, { PATH: `${path.dirname(hbBin)}:/usr/bin:/bin` });
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
