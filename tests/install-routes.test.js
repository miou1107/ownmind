// Zero-touch install, server half: the bootstrap scripts, the release archive and the
// first-load query a watcher polls. Query and auth are stubbed; scripts come from a
// fixture repo root so the test does not depend on the real install.sh contents.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/app-server.js';
import { tempDir } from './helpers/temp-dir.js';
import { createInstallRouter } from '../src/routes/install.js';
import { buildInstallArchive } from '../src/services/install-archive.js';
import { readZipEntries } from '../src/services/zip-writer.js';

const require = createRequire(import.meta.url);
const PKG_VERSION = require('../package.json').version;
const REAL_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'test-key';

function fakeAuth(req, res, next) {
  if (req.headers.authorization !== `Bearer ${KEY}`) return res.status(401).json({ error: 'unauthorized' });
  req.user = { id: 7 };
  next();
}

function makeFixtureRoot({ withRunbook = false } = {}) {
  const root = tempDir('install-routes-');
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  put('install.sh', '#!/usr/bin/env bash\necho fixture\n');
  put('install.ps1', '﻿Write-Host fixture\n');
  put('scripts/bootstrap.sh', '#!/usr/bin/env bash\necho bootstrap-fixture\n');
  put('scripts/bootstrap.ps1', '﻿Write-Host bootstrap-fixture\n');
  put('package.json', '{"version":"0.0.0"}\n');
  put('hooks/a.js', 'x');
  put('src/secret.js', 'x');
  put('src/app.js', 'x');
  put('src/routes/r.js', 'x');
  put('src/utils/md-parser.js', 'x');
  put('db/001.sql', 'x');
  put('tests/t.js', 'x');
  put('node_modules/m/index.js', 'x');
  put('client/node_modules/m/index.js', 'x');
  put('client/src/main.jsx', 'x');
  put('client/package.json', '{}');
  put('.git/HEAD', 'ref');
  if (withRunbook) put('docs/ai-install-runbook.md', '# runbook\n');
  return root;
}

function buildApp({ query, repoRoot }) {
  const app = express();
  app.use('/', createInstallRouter({ query, auth: fakeAuth, logger: { warn() {}, error() {} }, repoRoot }));
  return app;
}

describe('install routes', () => {
  let root, rootWithRunbook, srv, srv2, calls, rows;

  before(async () => {
    root = makeFixtureRoot();
    rootWithRunbook = makeFixtureRoot({ withRunbook: true });
    calls = [];
    rows = [];
    const query = async (sql, params) => { calls.push({ sql, params }); return { rows }; };
    srv = await startServer(buildApp({ query, repoRoot: root }));
    srv2 = await startServer(buildApp({ query, repoRoot: rootWithRunbook }));
  });
  after(async () => {
    await srv.close();
    await srv2.close();
  });

  it('serves install.sh anonymously as plain text, and the body is scripts/bootstrap.sh', async () => {
    const r = await fetch(`${srv.url}/install.sh`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/plain; charset=utf-8/);
    const body = await r.text();
    // A colleague without a version-control tool must get the bootstrap script, not the root
    // install.sh that clones with one.
    assert.equal(body, fs.readFileSync(path.join(root, 'scripts', 'bootstrap.sh'), 'utf8'));
    assert.notEqual(body, fs.readFileSync(path.join(root, 'install.sh'), 'utf8'));
  });

  it('serves install.ps1 anonymously without the byte order mark, and the body is scripts/bootstrap.ps1', async () => {
    const r = await fetch(`${srv.url}/install.ps1`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/plain; charset=utf-8/);
    const body = await r.text();
    assert.equal(body, 'Write-Host bootstrap-fixture\n');
    assert.notEqual(body, 'Write-Host fixture\n');
  });

  it('answers 404 manual_not_available until the runbook file exists', async () => {
    const r = await fetch(`${srv.url}/install-manual.md`);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'manual_not_available' });
  });

  it('serves the runbook as plain text once it exists', async () => {
    const r = await fetch(`${srv2.url}/install-manual.md`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/plain; charset=utf-8/);
    assert.equal(await r.text(), '# runbook\n');
  });

  it('serves the real runbook file on /install-manual.md, and the real install.sh route serves the bootstrap script', async () => {
    const realSrv = await startServer(buildApp({ query: async () => ({ rows: [] }), repoRoot: REAL_ROOT }));
    try {
      const manual = await fetch(`${realSrv.url}/install-manual.md`);
      assert.equal(manual.status, 200);
      assert.equal(await manual.text(), fs.readFileSync(path.join(REAL_ROOT, 'docs', 'ai-install-runbook.md'), 'utf8'));
      const sh = await fetch(`${realSrv.url}/install.sh`);
      assert.equal(await sh.text(), fs.readFileSync(path.join(REAL_ROOT, 'scripts', 'bootstrap.sh'), 'utf8'));
    } finally {
      await realSrv.close();
    }
  });

  it('refuses the archive without a key', async () => {
    const r = await fetch(`${srv.url}/api/install/archive`);
    assert.equal(r.status, 401);
  });

  it('HEAD on the archive answers the release without a body, behind the key', async () => {
    const anon = await fetch(`${srv.url}/api/install/archive`, { method: 'HEAD' });
    assert.equal(anon.status, 401);
    const r = await fetch(`${srv.url}/api/install/archive`, { method: 'HEAD', headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-ownmind-release'), `v${PKG_VERSION}`);
    assert.equal((await r.arrayBuffer()).byteLength, 0);
  });

  it('serves the archive with a key, tagged with the release version', async () => {
    const r = await fetch(`${srv.url}/api/install/archive`, { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^application\/gzip/);
    assert.equal(r.headers.get('x-ownmind-release'), `v${PKG_VERSION}`);
    const file = path.join(tempDir('install-routes-dl-'), 'archive.tar.gz');
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    try {
      const names = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' })
        .split(/\r?\n/).filter(Boolean).map((n) => n.replace(/^\.\//, ''));
      assert.ok(names.includes('.release'));
      assert.ok(names.includes('install.sh'));
      assert.ok(names.includes('install.ps1'));
      assert.ok(names.includes('hooks/a.js'));
      for (const bad of ['db/', 'tests/', '.git/', 'client/src/', 'src/routes/']) {
        assert.ok(!names.some((n) => n === bad.replace(/\/$/, '') || n.startsWith(bad)), `${bad} must not be packed`);
      }
      assert.ok(!names.includes('src/app.js'), 'src/app.js must not be packed');
      assert.ok(!names.includes('src/secret.js'), 'src/secret.js must not be packed');
      assert.ok(names.includes('src/utils/md-parser.js'), 'src/utils stays: the MCP server imports it');
      assert.ok(!names.some((n) => n.split('/').includes('node_modules')), 'node_modules must not be packed');
      assert.ok(names.includes('client/package.json'));
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('first-load: loaded=false when no init/hook row is newer than since', async () => {
    rows = [];
    calls.length = 0;
    const since = '2026-10-23T00:00:00.000Z';
    const r = await fetch(`${srv.url}/api/install/first-load?since=${encodeURIComponent(since)}`, { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { loaded: false, at: null });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, [7, since]);
    assert.match(calls[0].sql, /event\s*=\s*'init'/);
    assert.match(calls[0].sql, /source\s*=\s*'hook'/);
  });

  it('first-load: loaded=true with the timestamp when a row exists', async () => {
    const ts = new Date('2026-10-23T01:02:03.000Z');
    rows = [{ ts }];
    const r = await fetch(`${srv.url}/api/install/first-load?since=2026-10-23T00:00:00.000Z`, { headers: { authorization: `Bearer ${KEY}` } });
    assert.deepEqual(await r.json(), { loaded: true, at: ts.toISOString() });
  });

  it('first-load: a loose but parseable since reaches the database as a full ISO timestamp', async () => {
    rows = [];
    calls.length = 0;
    const r = await fetch(`${srv.url}/api/install/first-load?since=1`, { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(r.status, 200);
    assert.deepEqual(calls[0].params, [7, new Date(Date.parse('1')).toISOString()]);
  });

  it('first-load: refuses without a key and rejects a missing or malformed since', async () => {
    const anon = await fetch(`${srv.url}/api/install/first-load?since=2026-10-23T00:00:00.000Z`);
    assert.equal(anon.status, 401);
    for (const q of ['', '?since=yesterday']) {
      const r = await fetch(`${srv.url}/api/install/first-load${q}`, { headers: { authorization: `Bearer ${KEY}` } });
      assert.equal(r.status, 400, q);
    }
  });
});

describe('buildInstallArchive', () => {
  it('never ships a top-level name a client keeps its runtime state under, in either format', async () => {
    const root = makeFixtureRoot();
    const put = (rel, body = 'x') => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    };
    for (const rel of ['state/session.json', 'logs/server.log', 'credentials', 'runtime/node/bin/node', 'cache/c.json',
      'reports/r.json', 'judge.json', '.node-path', '.no-usage-scanner', '.last-update-check', '.update-lock',
      '.swap-journal.json', '.next/x', '.prev/x', '.next.download', '.reconfigure-pending']) put(rel);
    put('hooks/state/kept.js'); // only the top level is state; the same name deeper is code
    const top = (n) => n.replace(/^\.\//, '').split('/')[0];
    const forbidden = ['state', 'logs', 'credentials', 'runtime', 'cache', 'reports', 'judge.json', '.node-path',
      '.no-usage-scanner', '.last-update-check', '.update-lock', '.swap-journal.json', '.next', '.prev',
      '.next.download', '.reconfigure-pending'];
    for (const format of ['tar.gz', 'zip']) {
      const a = await buildInstallArchive({ repoRoot: root, version: 'v9.9.7-state', format });
      try {
        const names = format === 'zip'
          ? readZipEntries(a.path).map((e) => e.name)
          : execFileSync('tar', ['-tzf', a.path], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
        const shipped = forbidden.filter((f) => names.some((n) => top(n) === f));
        assert.deepEqual(shipped, [], `${format} ships runtime state: ${shipped}`);
        assert.ok(names.some((n) => n.replace(/^\.\//, '') === 'hooks/state/kept.js'), `${format}: a nested state/ is code and ships`);
        assert.ok(names.some((n) => n.replace(/^\.\//, '') === '.release'));
      } finally {
        fs.rmSync(a.path, { force: true });
      }
    }
  });

  it('writes the version into .release and reuses the file within one process', async () => {
    const root = makeFixtureRoot();
    const a = await buildInstallArchive({ repoRoot: root, version: 'v9.9.9' });
    try {
      assert.equal(a.version, 'v9.9.9');
      assert.equal(path.dirname(a.path), os.tmpdir());
      assert.match(path.basename(a.path), /^ownmind-install-v9\.9\.9-[0-9a-f]{12}\.tar\.gz$/);
      assert.match(a.sha256, /^[0-9a-f]{64}$/);
      const out = execFileSync('tar', ['-xzOf', a.path, '.release'], { encoding: 'utf8' });
      assert.equal(out.trim(), 'v9.9.9');
      const b = await buildInstallArchive({ repoRoot: root, version: 'v9.9.9' });
      assert.equal(b.sha256, a.sha256);
    } finally {
      fs.rmSync(a.path, { force: true });
    }
  });

  it('packs the real checkout without server code, node_modules or tests, but with src/utils', async () => {
    const a = await buildInstallArchive({ repoRoot: REAL_ROOT, version: 'v0.0.0-real' });
    try {
      const names = execFileSync('tar', ['-tzf', a.path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split(/\r?\n/).filter(Boolean);
      assert.ok(names.includes('.release'));
      assert.ok(names.includes('install.sh'));
      assert.ok(names.includes('src/utils/md-parser.js'));
      assert.ok(!names.some((n) => /^(db|tests|\.git)(\/|$)/.test(n)));
      assert.ok(!names.some((n) => /^src\/(?!utils(\/|$)).+/.test(n)), 'nothing under src/ except utils/');
      assert.ok(!names.some((n) => n.split('/').includes('node_modules')));
    } finally {
      fs.rmSync(a.path, { force: true });
    }
  });

  it('every ../src/ import made by the client code is inside the archive', async () => {
    const sources = [];
    for (const dir of ['mcp', 'mcp/lib', 'hooks', 'hooks/lib']) {
      for (const f of fs.readdirSync(path.join(REAL_ROOT, dir))) {
        if (/\.(c|m)?js$/.test(f) && fs.statSync(path.join(REAL_ROOT, dir, f)).isFile()) sources.push(path.join(dir, f));
      }
    }
    const wanted = new Map(); // archive path -> file that imports it
    for (const rel of sources) {
      const text = fs.readFileSync(path.join(REAL_ROOT, rel), 'utf8');
      for (const m of text.matchAll(/['"`]((?:\.\.\/)+src\/[^'"`]+\.[cm]?js)['"`]/g)) {
        const target = path.relative(REAL_ROOT, path.resolve(REAL_ROOT, path.dirname(rel), m[1])).split(path.sep).join('/');
        wanted.set(target, rel);
      }
    }
    assert.ok(wanted.size >= 4, `expected the known ../src/ imports to be found, got ${[...wanted.keys()]}`);
    const a = await buildInstallArchive({ repoRoot: REAL_ROOT, version: 'v0.0.0-imports' });
    try {
      const names = new Set(execFileSync('tar', ['-tzf', a.path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split(/\r?\n/).filter(Boolean));
      for (const [target, importer] of wanted) {
        assert.ok(names.has(target), `${importer} imports ${target}, which the archive does not contain`);
      }
    } finally {
      fs.rmSync(a.path, { force: true });
    }
  });
});
