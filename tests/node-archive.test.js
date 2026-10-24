// Server half of the private Node runtime: GET /api/install/node resolves the newest 22.x,
// downloads and verifies it once, then serves it from the cache. No network: `fetch` is injected.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import yaml from 'js-yaml';
import { startServer } from './helpers/app-server.js';
import { tempDir } from './helpers/temp-dir.js';
import { createInstallRouter } from '../src/routes/install.js';
import { createNodeArchiveService } from '../src/services/node-archive.js';

const KEY = 'test-key';
const VERSION = 'v22.11.0';
const ARCHIVE = 'node-v22.11.0-darwin-arm64.tar.gz';
const ZIP = 'node-v22.11.0-win-x64.zip';
const BODY = zlib.gzipSync(Buffer.from('pretend this is a node tarball'));
const SHA = crypto.createHash('sha256').update(BODY).digest('hex');
const INDEX = [{ version: 'v23.1.0' }, { version: VERSION }, { version: 'v22.10.0' }];

function fakeAuth(req, res, next) {
  if (req.headers.authorization !== `Bearer ${KEY}`) return res.status(401).json({ error: 'unauthorized' });
  req.user = { id: 7 };
  next();
}

const quiet = { warn() {}, error() {}, info() {} };

/** A fetch that answers like nodejs.org and records what was asked. */
function fakeFetch({ shasums } = {}) {
  const calls = [];
  const fn = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u === 'https://nodejs.org/dist/index.json') return new Response(JSON.stringify(INDEX));
    if (u === `https://nodejs.org/dist/${VERSION}/SHASUMS256.txt`) {
      return new Response(shasums ?? `${SHA}  ${ARCHIVE}\n${'0'.repeat(64)}  ${ZIP}\n`);
    }
    if (u === `https://nodejs.org/dist/${VERSION}/${ARCHIVE}` || u === `https://nodejs.org/dist/${VERSION}/${ZIP}`) {
      return new Response(BODY);
    }
    return new Response('not found', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

function boot(nodeArchive) {
  const app = express();
  app.use('/', createInstallRouter({ query: async () => ({ rows: [] }), auth: fakeAuth, logger: quiet, nodeArchive }));
  return startServer(app);
}

const get = (srv, qs) => fetch(`${srv.url}/api/install/node${qs}`, { headers: { Authorization: `Bearer ${KEY}` } });

function service(fetchImpl, dir = tempDir('node-archive-'), now = () => 1) {
  return createNodeArchiveService({ fetch: fetchImpl, cacheDir: dir, now, logger: quiet });
}

describe('GET /api/install/node', () => {
  let srv, fetchStub, cacheDir;

  before(async () => {
    cacheDir = tempDir('node-archive-');
    fetchStub = fakeFetch();
    srv = await boot(service(fetchStub, cacheDir));
  });
  after(() => srv.close());

  it('needs auth', async () => {
    const r = await fetch(`${srv.url}/api/install/node?os=darwin&arch=arm64`);
    assert.equal(r.status, 401);
  });

  it('answers 400 unsupported_platform for an unknown os or arch', async () => {
    for (const qs of ['?os=linux&arch=x64', '?os=darwin&arch=ia32', '?os=darwin', '']) {
      const r = await get(srv, qs);
      assert.equal(r.status, 400, qs);
      assert.deepEqual(await r.json(), { error: 'unsupported_platform' });
    }
    assert.equal(fetchStub.calls.length, 0, 'a bad request must not reach nodejs.org');
  });

  it('serves the archive with both headers, then serves the next request from the cache', async () => {
    const r = await get(srv, '?os=darwin&arch=arm64');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-node-version'), VERSION);
    assert.equal(r.headers.get('x-sha256'), SHA);
    assert.equal(r.headers.get('content-type'), 'application/gzip');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), BODY);
    assert.equal(fs.existsSync(path.join(cacheDir, ARCHIVE)), true);
    assert.equal(fs.existsSync(path.join(cacheDir, `${ARCHIVE}.partial`)), false);

    const before = fetchStub.calls.length;
    const again = await get(srv, '?os=darwin&arch=arm64');
    assert.equal(again.status, 200);
    assert.equal(again.headers.get('x-sha256'), SHA);
    assert.deepEqual(Buffer.from(await again.arrayBuffer()), BODY);
    assert.equal(fetchStub.calls.length, before, 'second request made a network call');
  });

  it('serves windows as application/zip', async () => {
    const stub = fakeFetch({ shasums: `${SHA}  ${ARCHIVE}\n${SHA}  ${ZIP}\n` });
    const s = await boot(service(stub));
    try {
      const r = await get(s, '?os=win32&arch=x64');
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'application/zip');
      assert.equal(r.headers.get('x-node-version'), VERSION);
      await r.arrayBuffer();
    } finally {
      await s.close();
    }
  });
});

describe('GET /api/install/node when nodejs.org cannot be used', () => {
  const expect503 = async (srv) => {
    const r = await get(srv, '?os=darwin&arch=arm64');
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: 'node_upstream_unavailable' });
  };

  it('answers 503 when fetch rejects', async () => {
    const s = await boot(service(async () => { throw new Error('ECONNREFUSED'); }));
    try { await expect503(s); } finally { await s.close(); }
  });

  it('answers 503 when nodejs.org answers with an error status', async () => {
    const s = await boot(service(async () => new Response('bad gateway', { status: 502 })));
    try { await expect503(s); } finally { await s.close(); }
  });

  it('answers 503 and keeps nothing when the checksum does not match', async () => {
    const dir = tempDir('node-archive-');
    const s = await boot(service(fakeFetch({ shasums: `${'1'.repeat(64)}  ${ARCHIVE}\n` }), dir));
    try {
      await expect503(s);
      assert.deepEqual(fs.readdirSync(dir), [], 'a corrupt download must not stay in the cache');
    } finally { await s.close(); }
  });

  it('answers 503 when the checksum list has no line for this archive', async () => {
    const s = await boot(service(fakeFetch({ shasums: `${SHA}  something-else.tar.gz\n` })));
    try { await expect503(s); } finally { await s.close(); }
  });

  it('answers 503 when the router has no Node archive service', async () => {
    const s = await boot(undefined);
    try { await expect503(s); } finally { await s.close(); }
  });
});

describe('GET /api/install/node error answers carry no archive headers', () => {
  it('a cached file that vanished gives a clean JSON 503', async () => {
    const s = await boot({ getArchive: async () => ({ path: path.join(tempDir('node-archive-'), 'gone.tar.gz'), version: VERSION, sha256: SHA }) });
    try {
      const r = await get(s, '?os=darwin&arch=arm64');
      assert.equal(r.status, 503);
      assert.match(r.headers.get('content-type'), /application\/json/);
      assert.equal(r.headers.get('x-sha256'), null);
      assert.equal(r.headers.get('x-node-version'), null);
      assert.deepEqual(await r.json(), { error: 'node_upstream_unavailable' });
    } finally { await s.close(); }
  });
});

describe('docker-compose.yml', () => {
  it('points the api service at the cache volume through INSTALL_CACHE_DIR', () => {
    const compose = yaml.load(fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8'));
    const api = compose.services.api;
    const dir = api.environment?.INSTALL_CACHE_DIR;
    assert.equal(dir, '/var/cache/ownmind-install');
    assert.ok(api.volumes.includes(`ownmind_install_cache:${dir}`), 'volume must be mounted at INSTALL_CACHE_DIR');
    assert.ok('ownmind_install_cache' in compose.volumes);
  });
});

describe('createNodeArchiveService', () => {
  it('only accepts plain v22.x.y releases from index.json', async () => {
    const stub = fakeFetch();
    const withJunk = async (url, opts) => (String(url).endsWith('/index.json')
      ? new Response(JSON.stringify([{ version: 'v22.12.0-rc.1' }, { version: 'v22.x' }, { version: 'v220.1.0' }, ...INDEX]))
      : stub(url, opts));
    const r = await service(withJunk).getArchive({ os: 'darwin', arch: 'arm64' });
    assert.equal(r.version, VERSION);
  });

  it('serves the newest cached archive when index.json cannot be fetched', async () => {
    const dir = tempDir('node-archive-');
    await service(fakeFetch(), dir).getArchive({ os: 'darwin', arch: 'arm64' });
    // An older verified release sits next to it; the newest one must win.
    fs.writeFileSync(path.join(dir, 'node-v22.9.0-darwin-arm64.tar.gz'), 'old');
    fs.writeFileSync(path.join(dir, 'node-v22.9.0-darwin-arm64.tar.gz.sha256'), `${'2'.repeat(64)}\n`);
    const down = async () => { throw new Error('ENETUNREACH'); };
    const s = await boot(service(down, dir));
    try {
      const r = await get(s, '?os=darwin&arch=arm64');
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('x-node-version'), VERSION);
      assert.equal(r.headers.get('x-sha256'), SHA);
      await r.arrayBuffer();
      // Another platform has nothing cached, so it is still a 503.
      const other = await get(s, '?os=win32&arch=x64');
      assert.equal(other.status, 503);
    } finally { await s.close(); }
  });

  it('resolves the first v22.x in index.json and asks for it once per 24 hours', async () => {
    let t = 0;
    const stub = fakeFetch();
    const svc = service(stub, tempDir('node-archive-'), () => t);
    const first = await svc.getArchive({ os: 'darwin', arch: 'arm64' });
    assert.equal(first.version, VERSION);
    assert.equal(first.sha256, SHA);
    assert.equal(first.path.endsWith(ARCHIVE), true);

    const indexCalls = () => stub.calls.filter((u) => u.endsWith('/index.json')).length;
    t = 23 * 3600 * 1000;
    await svc.getArchive({ os: 'darwin', arch: 'arm64' });
    assert.equal(indexCalls(), 1);
    t = 25 * 3600 * 1000;
    await svc.getArchive({ os: 'darwin', arch: 'arm64' });
    assert.equal(indexCalls(), 2);
  });

  it('downloads once when two requests arrive together', async () => {
    const stub = fakeFetch();
    const svc = service(stub);
    const [a, b] = await Promise.all([
      svc.getArchive({ os: 'darwin', arch: 'arm64' }),
      svc.getArchive({ os: 'darwin', arch: 'arm64' }),
    ]);
    assert.equal(a.path, b.path);
    assert.equal(stub.calls.filter((u) => u.endsWith(ARCHIVE)).length, 1);
  });

  it('re-downloads when the archive is cached but its checksum file is missing', async () => {
    const dir = tempDir('node-archive-');
    fs.writeFileSync(path.join(dir, ARCHIVE), 'half-written leftover');
    const svc = service(fakeFetch(), dir);
    const r = await svc.getArchive({ os: 'darwin', arch: 'arm64' });
    assert.equal(r.sha256, SHA);
    assert.deepEqual(fs.readFileSync(r.path), BODY);
  });
});
