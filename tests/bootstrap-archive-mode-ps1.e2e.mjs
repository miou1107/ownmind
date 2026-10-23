import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeZipFromDir } from '../src/services/zip-writer.js';

/**
 * Does a Windows machine with no git and no node end up with OwnMind unpacked from the release
 * archive, and with a private Node when it asks for one?
 *
 * This runs the real scripts/bootstrap.ps1 and scripts/install-helpers/ensure-node-runtime.ps1
 * under Windows PowerShell 5.1, with a PATH that holds only System32 and the PowerShell folder,
 * against a local HTTP server that plays the OwnMind server, GitHub and nodejs.org. Nothing here
 * touches the network. The zips are written by the same zip writer the server uses, so a zip the
 * server could produce is the zip Expand-Archive has to read. The server must be async and the
 * script spawned: a synchronous child of this process would block the event loop that has to
 * answer its requests.
 *
 * Skips itself anywhere but Windows (bootstrap.ps1 is a PowerShell script). Not in the
 * `node --test` default glob (extension is .mjs): the `install` job in .github/workflows/test.yml
 * runs it by name on the windows-latest leg, and tests/install-e2e-is-actually-run.test.js fails
 * if that stops being true. It was written on a Mac, where PowerShell is not available, so the
 * first real run is that CI leg.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bootstrap = path.join(repoRoot, 'scripts', 'bootstrap.ps1');
const ensureNode = path.join(repoRoot, 'scripts', 'install-helpers', 'ensure-node-runtime.ps1');
const KEY = 'archive-mode-test-key-0123456789';
const skip = process.platform === 'win32' ? false : 'bootstrap.ps1 is a PowerShell script; this runs on the Windows leg of CI';

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// No git and no node on PATH: only what a stock Windows has.
const BARE_PATH = `${SYSTEM_ROOT}\\System32;${SYSTEM_ROOT}\\System32\\WindowsPowerShell\\v1.0`;

const fixture = {
  server: null, url: '', dir: '', archive: null, githubArchive: null, nodeZip: null, nodeSha: '',
  mode: 'ok', nodeMode: 'ok', requests: [],
};

/** A zip holding a release: .release, an install.ps1 stub that records it ran, and one script. */
async function buildArchive(workDir, name, { top = '', release } = {}) {
  const src = path.join(workDir, `src-${name}`);
  const rootDir = top ? path.join(src, top) : src;
  fs.mkdirSync(path.join(rootDir, 'scripts'), { recursive: true });
  if (release) fs.writeFileSync(path.join(rootDir, '.release'), `${release}\r\n`);
  fs.writeFileSync(path.join(rootDir, 'install.ps1'), [
    '$args | Set-Content -LiteralPath (Join-Path $env:USERPROFILE "install-stub-args")',
    '(Get-Location).Path | Set-Content -LiteralPath (Join-Path $env:USERPROFILE "install-stub-cwd")',
    'if ($env:STUB_EXIT) { exit [int]$env:STUB_EXIT }',
    'exit 0',
    '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(rootDir, 'scripts', 'marker.ps1'), '# present\r\n');
  const out = path.join(workDir, `${name}.zip`);
  await writeZipFromDir({ dir: src, out });
  return fs.readFileSync(out);
}

/**
 * A Node "release" zip: nodejs.org's layout (one folder, node.exe inside) with a copy of the
 * node.exe that runs this test, so `node.exe --version` answers a real, matching version.
 */
async function buildNodeZip(workDir) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const src = path.join(workDir, 'src-node');
  const inner = path.join(src, `node-${process.version}-win-${arch}`);
  fs.mkdirSync(inner, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(inner, 'node.exe'));
  fs.writeFileSync(path.join(inner, 'npm.cmd'), '@echo off\r\n');
  const out = path.join(workDir, 'node.zip');
  await writeZipFromDir({ dir: src, out });
  const bytes = fs.readFileSync(out);
  return { bytes, sha: crypto.createHash('sha256').update(bytes).digest('hex'), name: `node-${process.version}-win-${arch}.zip` };
}

before(async () => {
  if (skip) return;
  fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-ps1-fixture-'));
  fixture.archive = await buildArchive(fixture.dir, 'server', { release: 'v9.9.9' });
  // GitHub archives have one top-level folder and no .release of their own.
  fixture.githubArchive = await buildArchive(fixture.dir, 'github', { top: 'ownmind-1.10.0' });
  const node = await buildNodeZip(fixture.dir);
  fixture.nodeZip = node;

  fixture.server = http.createServer((req, res) => {
    fixture.requests.push({ url: req.url, auth: req.headers.authorization || '' });
    const send = (code, body, type = 'text/plain') => {
      res.writeHead(code, { 'content-type': type });
      res.end(body);
    };
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/install/archive') {
      if (fixture.mode !== 'ok') return send(500, 'server error');
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, 'unauthorized');
      if (url.searchParams.get('format') !== 'zip') return send(400, 'the Windows installer must ask for the zip');
      res.writeHead(200, { 'content-type': 'application/zip', 'x-ownmind-release': 'v9.9.9' });
      return res.end(fixture.archive);
    }
    if (url.pathname === '/api/install/node') {
      if (fixture.nodeMode !== 'ok') return send(503, '{"error":"node_upstream_unavailable"}', 'application/json');
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, 'unauthorized');
      if (url.searchParams.get('os') !== 'win32') return send(400, 'wrong os');
      res.writeHead(200, {
        'content-type': 'application/zip', 'x-node-version': process.version, 'x-sha256': fixture.nodeZip.sha,
      });
      return res.end(fixture.nodeZip.bytes);
    }
    if (url.pathname.startsWith('/repos/miou1107/ownmind/tags')) {
      // Deliberately out of order, with 1.10.0 below 1.9.0 in a plain text sort.
      return send(200, JSON.stringify([{ name: 'v1.9.0' }, { name: 'v1.10.0' }, { name: 'v1.2.0' }, { name: 'nightly' }], null, 2), 'application/json');
    }
    if (url.pathname === '/miou1107/ownmind/archive/refs/tags/v1.10.0.zip') {
      res.writeHead(200, { 'content-type': 'application/zip' });
      return res.end(fixture.githubArchive);
    }
    // nodejs.org stand-in
    if (url.pathname === '/dist/index.json') {
      return send(200, JSON.stringify([{ version: 'v23.0.0' }, { version: process.version }, { version: 'v22.x.1' }], null, 2), 'application/json');
    }
    if (url.pathname === `/dist/${process.version}/SHASUMS256.txt`) {
      return send(200, `${fixture.nodeZip.sha}  ${fixture.nodeZip.name}\n${'0'.repeat(64)}  something-else.zip\n`);
    }
    if (url.pathname === `/dist/${process.version}/${fixture.nodeZip.name}`) {
      res.writeHead(200, { 'content-type': 'application/zip' });
      return res.end(fixture.nodeZip.bytes);
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
  if (skip) return;
  await new Promise((resolve) => fixture.server.close(resolve));
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

/** A fresh machine: an empty home and a PATH with no git and no node. */
function makeCleanWindows() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-ps1-home-'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(path|home|userprofile|ownmind_.*|claude.*|node_.*)$/i.test(k)) delete env[k];
  }
  Object.assign(env, { Path: BARE_PATH, USERPROFILE: home, HOME: home, OWNMIND_DIR: path.join(home, '.ownmind') });
  return { home, env, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function run(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { cwd: env.USERPROFILE, env });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, out }));
  });
}

/** Runs bootstrap.ps1 on a fresh simulated Windows; resolves with its output. */
function runBootstrap(win, extraEnv = {}, args = [KEY, fixture.url]) {
  return run(bootstrap, args, { ...win.env, ...extraEnv });
}

const readTrim = (file) => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();

test('no git: the release is downloaded, unpacked into ~/.ownmind, and install.ps1 runs', { skip }, async () => {
  const win = makeCleanWindows();
  try {
    fixture.mode = 'ok';
    fixture.requests = [];
    const r = await runBootstrap(win);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /INFO:archive_mode:git is not installed; installing from the release archive/);
    assert.match(r.out, /OK:unpack:release v9\.9\.9 unpacked/);

    const dir = path.join(win.home, '.ownmind');
    assert.equal(readTrim(path.join(dir, '.release')), 'v9.9.9');
    assert.ok(fs.existsSync(path.join(dir, 'scripts', 'marker.ps1')));
    assert.ok(!fs.existsSync(`${dir}.partial`), 'the partial directory must be gone after the move');
    assert.ok(!fs.existsSync(path.join(dir, 'archive.zip')), 'the downloaded archive must not be left inside the install');
    assert.deepEqual(
      fs.readFileSync(path.join(win.home, 'install-stub-args'), 'utf8').split(/\r?\n/).filter(Boolean),
      [KEY, fixture.url],
      'install.ps1 must receive the key and URL',
    );
    assert.equal(fs.realpathSync(readTrim(path.join(win.home, 'install-stub-cwd'))), fs.realpathSync(dir));
    assert.equal(fixture.requests[0].auth, `Bearer ${KEY}`);
    assert.match(fixture.requests[0].url, /format=zip/);
  } finally {
    win.cleanup();
  }
});

test('an unfinished download from an earlier attempt is cleared and started again', { skip }, async () => {
  const win = makeCleanWindows();
  try {
    fixture.mode = 'ok';
    const partial = path.join(win.home, '.ownmind.partial');
    fs.mkdirSync(partial);
    fs.writeFileSync(path.join(partial, 'archive.zip'), 'half a file');
    const r = await runBootstrap(win);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /INFO:clear_partial:/);
    assert.doesNotMatch(r.out, /FIX:clear_partial/, 'the FIX line is only for a delete that fails');
    assert.ok(!fs.existsSync(partial));
    assert.equal(readTrim(path.join(win.home, '.ownmind', '.release')), 'v9.9.9');
  } finally {
    win.cleanup();
  }
});

test('install.ps1 failing after a full unpack leaves a healthy archive install that the next run resumes', { skip }, async () => {
  const win = makeCleanWindows();
  try {
    fixture.mode = 'ok';
    const first = await runBootstrap(win, { STUB_EXIT: '1' });
    assert.notEqual(first.status, 0, first.out);
    assert.match(first.out, /OK:unpack:release v9\.9\.9 unpacked/);
    assert.match(first.out, /ERROR:install:/);
    const dir = path.join(win.home, '.ownmind');
    assert.ok(fs.existsSync(path.join(dir, '.release')), 'the unpack succeeded, so ~/.ownmind stays');
    assert.ok(!fs.existsSync(`${dir}.partial`));

    // Second run, install.ps1 passes now: it must not download again and must not treat the
    // directory as a broken clone.
    fixture.mode = '500';
    fixture.requests = [];
    const second = await runBootstrap(win);
    assert.equal(second.status, 0, second.out);
    assert.match(second.out, /INFO:already_installed:archive install found; re-running install\.ps1/);
    assert.doesNotMatch(second.out, /archive_mode|broken|\.broken\./);
    assert.equal(fixture.requests.length, 0, 'a healthy archive install must not be downloaded again');
    assert.deepEqual(fs.readdirSync(win.home).filter((n) => n.includes('.broken.')), []);
  } finally {
    win.cleanup();
  }
});

test('no key and no URL: it says what is needed and creates nothing', { skip }, async () => {
  const win = makeCleanWindows();
  try {
    const r = await runBootstrap(win, {}, []);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /ERROR:missing_args:/);
    assert.ok(!fs.existsSync(path.join(win.home, '.ownmind')));
    assert.ok(!fs.existsSync(path.join(win.home, '.ownmind.partial')));
  } finally {
    win.cleanup();
  }
});

test('server unreachable and OWNMIND_SOURCE=server: the person is told to check the network', { skip }, async () => {
  const win = makeCleanWindows();
  try {
    fixture.mode = '500';
    fixture.requests = [];
    // Pointed at the fixture so that any GitHub request would be recorded, not sent to github.com.
    const r = await runBootstrap(win, { OWNMIND_SOURCE: 'server', OWNMIND_GITHUB_API: fixture.url, OWNMIND_GITHUB_CODELOAD: fixture.url });
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /ERROR:download:/);
    assert.match(r.out, /FIX:use_fallback_source:/);
    assert.match(r.out, /ASK:no_network:The installer could not reach the OwnMind server or GitHub\. Check that this computer is online, then paste the same install message to the AI again\./);
    assert.ok(!fs.existsSync(path.join(win.home, '.ownmind')), 'nothing may be installed after a failed download');
    assert.ok(!fs.existsSync(path.join(win.home, '.ownmind.partial')), 'the empty partial directory must be removed');
    assert.ok(fixture.requests.length > 0, 'the server was asked');
    assert.ok(fixture.requests.every((q) => q.url.startsWith('/api/')), `no GitHub traffic when the source is forced to server: ${JSON.stringify(fixture.requests)}`);
  } finally {
    win.cleanup();
  }
});

test('server failing without a forced source falls back to GitHub, newest tag, folder stripped, key never sent', { skip }, async () => {
  const win = makeCleanWindows();
  try {
    fixture.mode = '500';
    fixture.requests = [];
    const r = await runBootstrap(win, { OWNMIND_GITHUB_API: fixture.url, OWNMIND_GITHUB_CODELOAD: fixture.url });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /INFO:fallback_source:/);
    assert.match(r.out, /OK:unpack:release v1\.10\.0 unpacked/);
    const dir = path.join(win.home, '.ownmind');
    assert.equal(readTrim(path.join(dir, '.release')), 'v1.10.0');
    assert.ok(fs.existsSync(path.join(dir, 'install.ps1')), 'the top-level folder must be stripped');
    assert.ok(!fs.existsSync(path.join(dir, 'ownmind-1.10.0')));
    const githubRequests = fixture.requests.filter((q) => !q.url.startsWith('/api/'));
    assert.ok(githubRequests.length >= 2, 'the tags list and the tag archive were both requested');
    assert.ok(githubRequests.every((q) => q.auth === ''), 'the key must never be sent to GitHub');
  } finally {
    win.cleanup();
  }
});

test('private Node: downloaded from the server, unpacked, linked with a junction, and exported', { skip }, async () => {
  const win = makeCleanWindows();
  try {
    fixture.nodeMode = 'ok';
    fixture.requests = [];
    const probe = path.join(win.home, 'probe.ps1');
    fs.writeFileSync(probe, [
      `. '${ensureNode.replace(/'/g, "''")}'`,
      `$ok = @(Ensure-OwnMindNode -ApiUrl '${fixture.url}' -ApiKey '${KEY}') | Select-Object -Last 1`,
      'Write-Output "RESULT=$ok"',
      'Write-Output "NODE=$($env:OWNMIND_NODE)"',
      'Write-Output "PRIVATE=$($env:OWNMIND_PRIVATE_NODE)"',
      'Write-Output "ONPATH=$(($env:Path -split \';\') -contains (Join-Path $env:OWNMIND_DIR \'runtime\\current\'))"',
      '$item = Get-Item -LiteralPath (Join-Path $env:OWNMIND_DIR \'runtime\\current\') -Force',
      'Write-Output "LINK=$($item.LinkType)"',
      'Write-Output "VERSION=$(& (Join-Path $env:OWNMIND_DIR \'runtime\\current\\node.exe\') --version)"',
      '',
    ].join('\r\n'));
    const r = await run(probe, [], win.env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, new RegExp(`OK:node:private Node ${process.version.replace(/\./g, '\\.')} installed`));
    assert.match(r.out, /RESULT=True/);
    assert.match(r.out, /PRIVATE=1/);
    assert.match(r.out, /ONPATH=True/);
    assert.match(r.out, /LINK=Junction/);
    assert.match(r.out, new RegExp(`VERSION=${process.version.replace(/\./g, '\\.')}`));
    const runtime = path.join(win.home, '.ownmind', 'runtime');
    assert.ok(fs.existsSync(path.join(runtime, 'current', 'node.exe')));
    assert.ok(fs.existsSync(path.join(runtime, `node-${process.version}`, 'node.exe')));
    assert.ok(!fs.existsSync(path.join(runtime, '.partial')), 'the partial directory must be gone');
    assert.equal(readTrim(path.join(win.home, '.ownmind', '.node-path')), path.join(runtime, 'current', 'node.exe'));
    const asked = fixture.requests.find((q) => q.url.startsWith('/api/install/node'));
    assert.ok(asked && asked.auth === `Bearer ${KEY}`);
    assert.match(asked.url, /os=win32/);

    // A second run finds the runtime and downloads nothing.
    fixture.requests = [];
    const again = await run(probe, [], win.env);
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /INFO:node:using private Node /);
    assert.equal(fixture.requests.length, 0, 'an installed private runtime must not be downloaded again');
  } finally {
    win.cleanup();
  }
});

test('private Node: the server is down, so nodejs.org is used', { skip }, async () => {
  const win = makeCleanWindows();
  try {
    fixture.nodeMode = '503';
    const probe = path.join(win.home, 'probe.ps1');
    fs.writeFileSync(probe, [
      `. '${ensureNode.replace(/'/g, "''")}'`,
      `$ok = @(Ensure-OwnMindNode -ApiUrl '${fixture.url}' -ApiKey '${KEY}') | Select-Object -Last 1`,
      'Write-Output "RESULT=$ok"',
      '',
    ].join('\r\n'));
    const viaNodejs = await run(probe, [], { ...win.env, OWNMIND_NODE_DIST: `${fixture.url}/dist` });
    assert.equal(viaNodejs.status, 0, viaNodejs.out);
    assert.match(viaNodejs.out, /INFO:node:The OwnMind server did not deliver Node\.js; trying nodejs\.org/);
    assert.match(viaNodejs.out, /RESULT=True/);
    assert.ok(fs.existsSync(path.join(win.home, '.ownmind', 'runtime', 'current', 'node.exe')));
  } finally {
    fixture.nodeMode = 'ok';
    win.cleanup();
  }
});

test('private Node: neither source works, so the person is asked to check the network', { skip }, async () => {
  const win = makeCleanWindows();
  try {
    fixture.nodeMode = '503';
    const probe = path.join(win.home, 'probe.ps1');
    fs.writeFileSync(probe, [
      `. '${ensureNode.replace(/'/g, "''")}'`,
      `$ok = @(Ensure-OwnMindNode -ApiUrl '${fixture.url}' -ApiKey '${KEY}') | Select-Object -Last 1`,
      'Write-Output "RESULT=$ok"',
      '',
    ].join('\r\n'));
    const r = await run(probe, [], { ...win.env, OWNMIND_NODE_DIST: `${fixture.url}/nothing-here` });
    assert.match(r.out, /ERROR:node_download:/);
    assert.match(r.out, /ASK:no_network:The installer could not download Node\.js from the OwnMind server or nodejs\.org\. Check that this computer is online, then paste the same install message to the AI again\./);
    assert.match(r.out, /RESULT=False/);
    assert.ok(!fs.existsSync(path.join(win.home, '.ownmind', 'runtime', 'current')), 'nothing may be linked after a failed download');
    assert.ok(!fs.existsSync(path.join(win.home, '.ownmind', 'runtime', '.partial')));
  } finally {
    fixture.nodeMode = 'ok';
    win.cleanup();
  }
});
