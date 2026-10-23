import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeCleanMac } from './helpers/clean-mac-sim.mjs';
import { tempDir } from './helpers/temp-dir.js';
import { NODE_LTS_MAJOR, nodeArchiveName } from '../shared/node-runtime.js';

/**
 * The private Node runtime on macOS (scripts/install-helpers/ensure-node-runtime.sh).
 *
 * A colleague's Mac has no Node, or an old one, and no admin rights. The installer must
 * download the official Node archive into ~/.ownmind/runtime and use it, while a machine that
 * already has a Node of v20 or newer keeps using that one and downloads nothing.
 *
 * The first describe reads the scripts. The second runs the real helper inside a simulated
 * clean Mac (tests/helpers/clean-mac-sim.mjs) against a fixture HTTP server that stands in
 * for the OwnMind server; its archive holds a fake `bin/node` that prints a version. The
 * fixture server is async and the driver is spawned (not spawnSync'd): a synchronous child
 * would block the event loop that has to answer its curl.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperPath = path.join(repoRoot, 'scripts', 'install-helpers', 'ensure-node-runtime.sh');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

describe('private Node runtime: scripts', () => {
  it('ensure-node-runtime.sh defines ownmind_ensure_node and parses as bash', () => {
    assert.match(read('scripts/install-helpers/ensure-node-runtime.sh'), /^ownmind_ensure_node\(\) \{/m);
    const r = spawnSync('bash', ['-n', helperPath], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });

  it('install.sh sources the helper, calls ownmind_ensure_node, and no longer runs brew install node', () => {
    const src = read('install.sh');
    assert.match(src, /ensure-node-runtime\.sh/);
    assert.match(src, /ownmind_ensure_node "\$API_URL" "\$API_KEY"/);
    assert.doesNotMatch(src, /brew install node/);
  });

  it('install.sh keeps today\'s Linux and Windows messages', () => {
    const src = read('install.sh');
    assert.match(src, /Linux: install Node\.js v20\+ manually and re-run/);
    assert.match(src, /Windows: run install\.ps1 instead/);
    assert.match(src, /Node\.js too old \(v\$NODE_VER\)/);
  });

  it('the shell archive name and the Node line match shared/node-runtime.js for both Darwin arches', () => {
    const src = read('scripts/install-helpers/ensure-node-runtime.sh');
    assert.match(src, new RegExp(`^OWNMIND_NODE_LTS_MAJOR=${NODE_LTS_MAJOR}$`, 'm'));
    // A script file rather than `bash -c <string>` (see tests/bash-c-escaping.test.js).
    const driver = path.join(tempDir('node-runtime-name-'), 'name-driver.sh');
    fs.writeFileSync(driver, [
      `. "${helperPath}"`,
      'ownmind_node_archive_name "$1" "$2"',
      '',
    ].join('\n'));
    for (const arch of ['arm64', 'x64']) {
      const version = 'v22.11.0';
      const r = spawnSync('bash', [driver, version, arch], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), nodeArchiveName({ os: 'darwin', arch, version }));
    }
  });

  it('preflight.sh on a Mac reports a missing node as informational and does not count it', {
    skip: process.platform === 'darwin' ? false : 'the Darwin branch of preflight.sh only runs on a Mac',
  }, () => {
    // A clean Mac has neither node nor git. With no .git under OWNMIND_DIR (an archive install)
    // the assert has nothing to complain about; the report still says what will happen.
    const mac = makeCleanMac();
    try {
      const driver = path.join(mac.home, 'preflight-driver.sh');
      fs.writeFileSync(driver, [
        `. "${path.join(repoRoot, 'scripts', 'install-helpers', 'preflight.sh')}"`,
        'ownmind_preflight_failures',
        'ownmind_preflight_assert install; echo "ASSERT_RC=$?"',
        '',
      ].join('\n'));
      const r = spawnSync('bash', [driver], { encoding: 'utf8', env: { ...mac.env, OWNMIND_DIR: path.join(mac.home, '.ownmind') } });
      assert.match(r.stdout, /^node\tprivate runtime will be installed\t\(no action needed\)$/m);
      assert.doesNotMatch(r.stdout, /^npm\t/m, 'npm comes with the private Node, so it is not asked about');
      assert.match(r.stdout, /ASSERT_RC=0/);
      assert.doesNotMatch(r.stderr, /ERROR:preflight/);
    } finally {
      mac.cleanup();
    }
  });

  it('preflight.sh on a Mac still stops for git when OWNMIND_DIR is a git checkout', {
    skip: process.platform === 'darwin' ? false : 'the Darwin branch of preflight.sh only runs on a Mac',
  }, () => {
    const mac = makeCleanMac();
    try {
      fs.mkdirSync(path.join(mac.home, '.ownmind', '.git'), { recursive: true });
      const driver = path.join(mac.home, 'preflight-driver.sh');
      fs.writeFileSync(driver, [
        `. "${path.join(repoRoot, 'scripts', 'install-helpers', 'preflight.sh')}"`,
        'ownmind_preflight_assert upgrade; echo "ASSERT_RC=$?"',
        '',
      ].join('\n'));
      const r = spawnSync('bash', [driver], { encoding: 'utf8', env: { ...mac.env, OWNMIND_DIR: path.join(mac.home, '.ownmind') } });
      assert.match(r.stdout, /ASSERT_RC=1/);
      assert.match(r.stderr, /ERROR:preflight_missing_git/);
      assert.doesNotMatch(r.stderr, /preflight_missing_node/);
    } finally {
      mac.cleanup();
    }
  });
});

const skipE2e = process.platform === 'darwin' ? false : 'the private runtime is macOS-only; this section runs on a Mac';
const KEY = 'node-runtime-test-key-0123456789';
const unameM = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim();
const ARCH = unameM === 'arm64' ? 'arm64' : 'x64';
const FIXTURE_VERSION = 'v22.0.0';

const fixture = { server: null, url: '', dir: '', archive: null, sha: '', mode: 'ok', requests: [], driver: '' };

/** A tar.gz shaped like nodejs.org's: one top-level folder with bin/node and bin/npm. */
function buildNodeArchive(workDir) {
  const top = `node-${FIXTURE_VERSION}-darwin-${ARCH}`;
  const bin = path.join(workDir, 'src', top, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/bash\necho ${FIXTURE_VERSION}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/bash\necho 10.0.0\n', { mode: 0o755 });
  const out = path.join(workDir, `${top}.tar.gz`);
  const r = spawnSync('tar', ['-czf', out, '-C', path.join(workDir, 'src'), top], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(out);
}

before(async () => {
  if (skipE2e) return;
  fixture.dir = tempDir('node-runtime-fixture-');
  fixture.archive = buildNodeArchive(fixture.dir);
  fixture.sha = crypto.createHash('sha256').update(fixture.archive).digest('hex');
  // Written as a file so the test never passes a script as a command argument.
  fixture.driver = path.join(fixture.dir, 'driver.sh');
  fs.writeFileSync(fixture.driver, [
    `. "${helperPath}"`,
    'ownmind_ensure_node "$FIXTURE_API" "$FIXTURE_KEY"',
    'rc=$?',
    'echo "RC=$rc"',
    'echo "PRIVATE=${OWNMIND_PRIVATE_NODE:-unset}"',
    'echo "NODE=${OWNMIND_NODE:-unset}"',
    'echo "PATH0=${PATH%%:*}"',
    'exit "$rc"',
    '',
  ].join('\n'));

  fixture.server = http.createServer((req, res) => {
    fixture.requests.push({ url: req.url, auth: req.headers.authorization || '' });
    if (req.url === `/api/install/node?os=darwin&arch=${ARCH}`) {
      if (fixture.mode === '503') {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'node_upstream_unavailable' }));
      }
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        res.writeHead(401);
        return res.end('unauthorized');
      }
      res.writeHead(200, {
        'content-type': 'application/gzip',
        'x-node-version': FIXTURE_VERSION,
        'x-sha256': fixture.mode === 'badsha' ? '0'.repeat(64) : fixture.sha,
      });
      return res.end(fixture.archive);
    }
    res.writeHead(404);
    return res.end('not found');
  });
  await new Promise((resolve, reject) => {
    fixture.server.once('error', reject);
    fixture.server.listen(0, '127.0.0.1', resolve);
  });
  fixture.url = `http://127.0.0.1:${fixture.server.address().port}`;
});

after(async () => {
  if (skipE2e) return;
  await new Promise((resolve) => fixture.server.close(resolve));
});

/** Runs the driver (helper + ownmind_ensure_node) on the simulated Mac; resolves with output. */
function runEnsure(mac, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [fixture.driver], {
      cwd: mac.home,
      env: {
        ...mac.env,
        OWNMIND_DIR: path.join(mac.home, '.ownmind'),
        FIXTURE_API: fixture.url,
        FIXTURE_KEY: KEY,
        // Never reach the real nodejs.org: a nodejs fallback in these runs fails fast.
        OWNMIND_NODE_DIST: `${fixture.url}/dist`,
        ...extraEnv,
      },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, out }));
  });
}

function fakeNode(mac, version) {
  fs.writeFileSync(path.join(mac.binDir, 'node'), `#!/bin/bash\necho ${version}\n`, { mode: 0o755 });
}

function nodeRequests() {
  return fixture.requests.filter((r) => r.url.startsWith('/api/install/node'));
}

describe('private Node runtime: ensure_node on a simulated clean Mac', () => {
  it('no node at all: the private runtime is downloaded, linked, and used', { skip: skipE2e }, async () => {
    const mac = makeCleanMac();
    try {
      fixture.mode = 'ok';
      fixture.requests = [];
      const r = await runEnsure(mac);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, new RegExp(`OK:node:private Node ${FIXTURE_VERSION} installed`));

      const runtime = path.join(mac.home, '.ownmind', 'runtime');
      const nodeBin = path.join(runtime, 'current', 'bin', 'node');
      assert.ok(fs.existsSync(nodeBin), 'runtime/current/bin/node must exist');
      assert.ok(fs.existsSync(path.join(runtime, `node-${FIXTURE_VERSION}`, 'bin', 'npm')));
      assert.equal(fs.readlinkSync(path.join(runtime, 'current')), `node-${FIXTURE_VERSION}`);
      assert.equal(fs.readFileSync(path.join(mac.home, '.ownmind', '.node-path'), 'utf8').trim(), nodeBin);
      assert.ok(!fs.existsSync(path.join(runtime, '.partial')), 'the partial download folder must be gone');
      assert.match(r.out, new RegExp(`NODE=${nodeBin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(r.out, /PRIVATE=1/);
      assert.match(r.out, new RegExp(`PATH0=${path.join(runtime, 'current', 'bin').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.equal(nodeRequests().length, 1);
      assert.equal(nodeRequests()[0].auth, `Bearer ${KEY}`);
    } finally {
      mac.cleanup();
    }
  });

  it('a second run reuses the private runtime without downloading again', { skip: skipE2e }, async () => {
    const mac = makeCleanMac();
    try {
      fixture.mode = 'ok';
      fixture.requests = [];
      assert.equal((await runEnsure(mac)).status, 0);
      const again = await runEnsure(mac);
      assert.equal(again.status, 0, again.out);
      assert.match(again.out, /INFO:node:using private Node v22\.0\.0/);
      assert.match(again.out, /PRIVATE=1/);
      assert.equal(nodeRequests().length, 1, 'the second run must not download');
    } finally {
      mac.cleanup();
    }
  });

  it('a system node of v18 is too old: the private runtime is still installed and used', { skip: skipE2e }, async () => {
    const mac = makeCleanMac();
    try {
      fixture.mode = 'ok';
      fixture.requests = [];
      fakeNode(mac, 'v18.20.0');
      const r = await runEnsure(mac);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /OK:node:private Node v22\.0\.0 installed/);
      assert.match(r.out, /PRIVATE=1/);
      assert.ok(fs.existsSync(path.join(mac.home, '.ownmind', 'runtime', 'current', 'bin', 'node')));
      assert.equal(nodeRequests().length, 1);
    } finally {
      mac.cleanup();
    }
  });

  it('a system node of v22.5.0 is used as it is: no download, OWNMIND_PRIVATE_NODE not set', { skip: skipE2e }, async () => {
    const mac = makeCleanMac();
    try {
      fixture.mode = 'ok';
      fixture.requests = [];
      fakeNode(mac, 'v22.5.0');
      const r = await runEnsure(mac);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /INFO:node:using system node v22\.5\.0/);
      assert.match(r.out, /PRIVATE=unset/);
      assert.match(r.out, new RegExp(`NODE=${path.join(mac.binDir, 'node').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.equal(fixture.requests.length, 0, 'the fixture must not have been contacted');
      assert.ok(!fs.existsSync(path.join(mac.home, '.ownmind', 'runtime')), 'nothing may be created under runtime/');
      assert.ok(!fs.existsSync(path.join(mac.home, '.ownmind', '.node-path')), 'install.sh writes .node-path for a system node, not this helper');
    } finally {
      mac.cleanup();
    }
  });

  it('server answers 503 and the source is forced to the server: ERROR and ASK, exit 1, no runtime', { skip: skipE2e }, async () => {
    const mac = makeCleanMac();
    try {
      fixture.mode = '503';
      fixture.requests = [];
      const r = await runEnsure(mac, { OWNMIND_NODE_SOURCE: 'server' });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /ERROR:node_download:/);
      assert.match(r.out, /ASK:no_network:The installer could not download Node\.js from the OwnMind server or nodejs\.org/);
      assert.ok(!fs.existsSync(path.join(mac.home, '.ownmind', 'runtime', 'current')));
      assert.ok(!fs.existsSync(path.join(mac.home, '.ownmind', 'runtime', '.partial')));
      assert.ok(!fs.existsSync(path.join(mac.home, '.ownmind', '.node-path')));
    } finally {
      mac.cleanup();
      fixture.mode = 'ok';
    }
  });

  it('a wrong checksum is refused: nothing is installed and the bad archive is deleted', { skip: skipE2e }, async () => {
    const mac = makeCleanMac();
    try {
      fixture.mode = 'badsha';
      fixture.requests = [];
      const r = await runEnsure(mac, { OWNMIND_NODE_SOURCE: 'server' });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /ERROR:node_download:/);
      assert.ok(!fs.existsSync(path.join(mac.home, '.ownmind', 'runtime', 'current')));
      assert.ok(!fs.existsSync(path.join(mac.home, '.ownmind', 'runtime', '.partial')));
    } finally {
      mac.cleanup();
      fixture.mode = 'ok';
    }
  });

  it('server down and no forced source: it falls back to nodejs.org (here an unreachable fixture path) and then asks', { skip: skipE2e }, async () => {
    const mac = makeCleanMac();
    try {
      fixture.mode = '503';
      fixture.requests = [];
      const r = await runEnsure(mac);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /INFO:node:The OwnMind server did not deliver Node\.js; trying nodejs\.org/);
      assert.ok(fixture.requests.some((q) => q.url === '/dist/index.json'), 'the nodejs.org fallback must have been tried');
      assert.match(r.out, /ASK:no_network:/);
    } finally {
      mac.cleanup();
      fixture.mode = 'ok';
    }
  });
});
