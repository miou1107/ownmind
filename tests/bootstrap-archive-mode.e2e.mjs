import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeCleanMac } from './helpers/clean-mac-sim.mjs';

/**
 * Does a machine with no git end up with OwnMind unpacked from the release archive?
 *
 * This runs the real scripts/bootstrap.sh inside a simulated clean Mac (no git, no node) against
 * a local HTTP server that plays both the OwnMind server and GitHub. Nothing here touches the
 * network. The server must be an async one and the script must be spawned, not spawnSync'd:
 * a synchronous child of this process would block the event loop that has to answer its curl.
 *
 * Not in the `node --test` default glob (extension is .mjs, not .test.js), like
 * install-clean-machine.e2e.mjs. The `install` job in .github/workflows/test.yml runs it by
 * name and tests/install-e2e-is-actually-run.test.js fails if that stops being true.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bootstrap = path.join(repoRoot, 'scripts', 'bootstrap.sh');
const KEY = 'archive-mode-test-key-0123456789';
const skip = process.platform === 'win32' ? 'bootstrap.sh is a bash script; Windows has bootstrap.ps1' : false;

const fixture = { server: null, url: '', dir: '', archive: null, githubArchive: null, mode: 'ok', requests: [] };

/** A tar.gz holding a release: .release, an install.sh stub that records it ran, and one script. */
function buildArchive(workDir, name, { top = '', release } = {}) {
  const src = path.join(workDir, `src-${name}`);
  const root = top ? path.join(src, top) : src;
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  if (release) fs.writeFileSync(path.join(root, '.release'), `${release}\n`);
  fs.writeFileSync(path.join(root, 'install.sh'), [
    '#!/bin/sh',
    'printf \'%s\\n\' "$@" > "$HOME/install-stub-args"',
    'pwd > "$HOME/install-stub-cwd"',
    'exit "${STUB_EXIT:-0}"',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'scripts', 'marker.sh'), '# present\n');
  const out = path.join(workDir, `${name}.tar.gz`);
  const entries = top ? [top] : fs.readdirSync(src);
  const r = spawnSync('tar', ['-czf', out, '-C', src, ...entries], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(out);
}

before(async () => {
  fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-archive-fixture-'));
  fixture.archive = buildArchive(fixture.dir, 'server', { release: 'v9.9.9' });
  // GitHub archives have one top-level folder and no .release of their own.
  fixture.githubArchive = buildArchive(fixture.dir, 'github', { top: 'ownmind-1.10.0' });

  fixture.server = http.createServer((req, res) => {
    fixture.requests.push({ url: req.url, auth: req.headers.authorization || '' });
    const send = (code, body, type = 'text/plain') => {
      res.writeHead(code, { 'content-type': type });
      res.end(body);
    };
    if (req.url === '/api/install/archive') {
      if (fixture.mode !== 'ok') return send(500, 'server error');
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, 'unauthorized');
      res.writeHead(200, { 'content-type': 'application/gzip', 'x-ownmind-release': 'v9.9.9' });
      return res.end(fixture.archive);
    }
    if (req.url.startsWith('/repos/miou1107/ownmind/tags')) {
      // Deliberately out of order, with 1.10.0 below 1.9.0 in a plain text sort.
      return send(200, JSON.stringify([{ name: 'v1.9.0' }, { name: 'v1.10.0' }, { name: 'v1.2.0' }, { name: 'nightly' }], null, 2), 'application/json');
    }
    if (req.url === '/miou1107/ownmind/tar.gz/refs/tags/v1.10.0') {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      return res.end(fixture.githubArchive);
    }
    return send(404, 'not found');
  });
  await new Promise((resolve, reject) => {
    fixture.server.once('error', reject);
    fixture.server.listen(0, '127.0.0.1', resolve);
  });
  fixture.url = `http://127.0.0.1:${fixture.server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => fixture.server.close(resolve));
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

/** Runs bootstrap.sh on a fresh simulated Mac; resolves with its output and the machine. */
function runBootstrap(mac, extraEnv = {}, args = [KEY, fixture.url]) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [bootstrap, ...args], {
      cwd: mac.home,
      env: { ...mac.env, OWNMIND_DIR: path.join(mac.home, '.ownmind'), ...extraEnv },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, out }));
  });
}

test('no git: the release is downloaded, unpacked into ~/.ownmind, and install.sh runs', { skip }, async () => {
  const mac = makeCleanMac();
  try {
    fixture.mode = 'ok';
    fixture.requests = [];
    const gitCheck = spawnSync('sh', ['-c', 'command -v git'], { env: mac.env });
    assert.notEqual(gitCheck.status, 0, 'the simulated machine must not have git');

    const r = await runBootstrap(mac);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /INFO:archive_mode:git is not installed; installing from the release archive/);
    assert.match(r.out, /OK:unpack:release v9\.9\.9 unpacked/);

    const dir = path.join(mac.home, '.ownmind');
    assert.equal(fs.readFileSync(path.join(dir, '.release'), 'utf8').trim(), 'v9.9.9');
    assert.ok(fs.existsSync(path.join(dir, 'scripts', 'marker.sh')));
    assert.ok(!fs.existsSync(`${dir}.partial`), 'the partial directory must be gone after the rename');
    assert.ok(!fs.existsSync(path.join(dir, 'archive.tar.gz')), 'the downloaded archive must not be left inside the install');
    assert.deepEqual(
      fs.readFileSync(path.join(mac.home, 'install-stub-args'), 'utf8').trim().split('\n'),
      [KEY, fixture.url],
      'install.sh must receive the key and URL',
    );
    assert.equal(fs.realpathSync(fs.readFileSync(path.join(mac.home, 'install-stub-cwd'), 'utf8').trim()), fs.realpathSync(dir));
    assert.equal(fixture.requests[0].auth, `Bearer ${KEY}`);
  } finally {
    mac.cleanup();
  }
});

test('an unfinished download from an earlier attempt is cleared and started again', { skip }, async () => {
  const mac = makeCleanMac();
  try {
    fixture.mode = 'ok';
    const partial = path.join(mac.home, '.ownmind.partial');
    fs.mkdirSync(partial);
    fs.writeFileSync(path.join(partial, 'archive.tar.gz'), 'half a file');

    const r = await runBootstrap(mac);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /INFO:clear_partial:/);
    assert.doesNotMatch(r.out, /FIX:clear_partial/, 'the FIX line is only for a delete that fails');
    assert.ok(!fs.existsSync(partial));
    assert.equal(fs.readFileSync(path.join(mac.home, '.ownmind', '.release'), 'utf8').trim(), 'v9.9.9');
  } finally {
    mac.cleanup();
  }
});

test('install.sh failing after a full unpack leaves a healthy archive install that the next run resumes', { skip }, async () => {
  const mac = makeCleanMac();
  try {
    fixture.mode = 'ok';
    const first = await runBootstrap(mac, { STUB_EXIT: '1' });
    assert.notEqual(first.status, 0, first.out);
    assert.match(first.out, /OK:unpack:release v9\.9\.9 unpacked/);
    assert.match(first.out, /ERROR:install:/);
    const dir = path.join(mac.home, '.ownmind');
    assert.ok(fs.existsSync(path.join(dir, '.release')), 'the unpack succeeded, so ~/.ownmind stays');
    assert.ok(!fs.existsSync(`${dir}.partial`));

    // Second run, install.sh passes now: it must not download again and must not treat the
    // directory as a broken clone.
    fixture.mode = '500';
    fixture.requests = [];
    const second = await runBootstrap(mac);
    assert.equal(second.status, 0, second.out);
    assert.match(second.out, /INFO:already_installed:archive install found; re-running install\.sh/);
    assert.doesNotMatch(second.out, /archive_mode|broken|\.broken\./);
    assert.equal(fixture.requests.length, 0, 'a healthy archive install must not be downloaded again');
    assert.deepEqual(fs.readdirSync(mac.home).filter((n) => n.includes('.broken.')), []);
  } finally {
    mac.cleanup();
  }
});

test('server unreachable and OWNMIND_SOURCE=server: the person is told to check the network', { skip }, async () => {
  const mac = makeCleanMac();
  try {
    fixture.mode = '500';
    const r = await runBootstrap(mac, { OWNMIND_SOURCE: 'server' });
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /ERROR:download:/);
    assert.match(r.out, /FIX:use_fallback_source:OWNMIND_SOURCE=github bash <same one-liner>/);
    assert.match(r.out, /ASK:no_network:The installer could not reach the OwnMind server or GitHub\. Check that this computer is online, then paste the same install message to the AI again\./);
    assert.ok(!fs.existsSync(path.join(mac.home, '.ownmind')), 'nothing may be installed after a failed download');
  } finally {
    mac.cleanup();
  }
});

test('server failing without a forced source falls back to GitHub, newest tag, folder stripped', { skip }, async () => {
  const mac = makeCleanMac();
  try {
    fixture.mode = '500';
    const r = await runBootstrap(mac, { OWNMIND_GITHUB_API: fixture.url, OWNMIND_GITHUB_CODELOAD: fixture.url });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /INFO:fallback_source:/);
    assert.match(r.out, /OK:unpack:release v1\.10\.0 unpacked/);
    const dir = path.join(mac.home, '.ownmind');
    assert.equal(fs.readFileSync(path.join(dir, '.release'), 'utf8').trim(), 'v1.10.0');
    assert.ok(fs.existsSync(path.join(dir, 'install.sh')), 'the top-level folder must be stripped');
    assert.ok(!fs.existsSync(path.join(dir, 'ownmind-1.10.0')));
    const githubRequests = fixture.requests.filter((q) => !q.url.startsWith('/api/'));
    assert.ok(githubRequests.length >= 2, 'the tags list and the tag archive were both requested');
    assert.ok(githubRequests.every((q) => q.auth === ''), 'the key must never be sent to GitHub');
  } finally {
    mac.cleanup();
  }
});
