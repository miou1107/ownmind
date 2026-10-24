// The Windows half of the release archive: the same staged tree as the .tar.gz, written as a
// .zip by a small built-in writer, because Expand-Archive reads nothing else. These tests read
// the zip back two ways: through the writer's own central-directory reader (which checks sizes
// and CRC-32) and, where an `unzip` exists, through the system tool.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer } from './helpers/app-server.js';
import { tempDir } from './helpers/temp-dir.js';
import { createInstallRouter } from '../src/routes/install.js';
import { buildInstallArchive } from '../src/services/install-archive.js';
import { writeZipFromDir, readZipEntries, crc32 } from '../src/services/zip-writer.js';

const KEY = 'test-key';
const hasUnzip = spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0;
// A non-ASCII member name, spelled with escapes so this file stays ASCII.
const NON_ASCII_NAME = 'm記憶.md';

function fakeAuth(req, res, next) {
  if (req.headers.authorization !== `Bearer ${KEY}`) return res.status(401).json({ error: 'unauthorized' });
  req.user = { id: 7 };
  next();
}

function makeFixtureRoot() {
  const root = tempDir('install-zip-');
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  put('install.sh', '#!/usr/bin/env bash\necho fixture\n');
  put('install.ps1', 'Write-Host fixture\n');
  put('package.json', '{"version":"0.0.0"}\n');
  put('hooks/a.js', 'x');
  put('src/app.js', 'x');
  put('src/routes/r.js', 'x');
  put('src/utils/md-parser.js', 'x');
  put('db/001.sql', 'x');
  put('tests/t.js', 'x');
  put('node_modules/m/index.js', 'x');
  put('client/src/main.jsx', 'x');
  put('client/package.json', '{}');
  put('.git/HEAD', 'ref');
  // Secrets a server started from a working copy can hold.
  put('.env', 'DB_PASSWORD=secret\n');
  put('.env.production', 'DB_PASSWORD=secret\n');
  put('.env.example', 'DB_PASSWORD=\n');
  put('mcp/server.pem', 'placeholder certificate body\n');
  return root;
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    assert.equal(crc32(Buffer.alloc(0)), 0);
  });
});

describe('writeZipFromDir', () => {
  it('writes files, directories, empty files, non-ASCII names, compressible and incompressible content', async () => {
    const src = tempDir('zip-src-');
    const out = path.join(tempDir('zip-out-'), 'tree.zip');
    const random = crypto.randomBytes(5000);
    const text = Buffer.from('line of text\n'.repeat(2000));
    fs.mkdirSync(path.join(src, 'a', 'b'), { recursive: true });
    fs.mkdirSync(path.join(src, 'empty-dir'));
    fs.writeFileSync(path.join(src, 'a', 'b', 'text.txt'), text);
    fs.writeFileSync(path.join(src, 'a', 'random.bin'), random);
    fs.writeFileSync(path.join(src, 'empty.txt'), '');
    fs.writeFileSync(path.join(src, NON_ASCII_NAME), '# note\n');
    fs.writeFileSync(path.join(src, '.release'), 'v1.2.3\n');
    const { entries } = await writeZipFromDir({ dir: src, out });
    const members = readZipEntries(out);
    assert.equal(entries, members.length);
    const byName = new Map(members.map((m) => [m.name, m]));
    for (const dir of ['a/', 'a/b/', 'empty-dir/']) {
      assert.ok(byName.get(dir)?.isDirectory, `${dir} should be a directory entry`);
    }
    assert.ok(text.equals(byName.get('a/b/text.txt').data));
    assert.ok(random.equals(byName.get('a/random.bin').data));
    assert.equal(byName.get('empty.txt').data.length, 0);
    assert.equal(byName.get(NON_ASCII_NAME).data.toString('utf8'), '# note\n');
    assert.equal(byName.get('.release').data.toString('utf8'), 'v1.2.3\n');
    for (const m of members) assert.ok(!m.name.includes('\\'), 'member names use forward slashes');
    // Directories come before what they hold, so an extractor that does not create parents still works.
    assert.ok(members.findIndex((m) => m.name === 'a/') < members.findIndex((m) => m.name === 'a/b/text.txt'));
    // The compressible file is deflated, the random one stays stored (deflate would grow it).
    assert.ok(fs.statSync(out).size < text.length + random.length, 'compressible content must shrink');
  });

  it('the system unzip accepts the file', { skip: hasUnzip ? false : 'no unzip on this machine; the central-directory reader above did the checking' }, async () => {
    const src = tempDir('zip-src2-');
    const out = path.join(tempDir('zip-out2-'), 'tree.zip');
    fs.mkdirSync(path.join(src, 'x'), { recursive: true });
    fs.writeFileSync(path.join(src, 'x', 'y.txt'), 'hello\n'.repeat(500));
    fs.writeFileSync(path.join(src, 'z.txt'), 'z');
    await writeZipFromDir({ dir: src, out });
    const test = spawnSync('unzip', ['-tq', out], { encoding: 'utf8' });
    assert.equal(test.status, 0, `${test.stdout}${test.stderr}`);
    const list = spawnSync('unzip', ['-Z1', out], { encoding: 'utf8' }).stdout.split(/\r?\n/).filter(Boolean);
    assert.deepEqual(list.sort(), ['x/', 'x/y.txt', 'z.txt']);
    const dest = tempDir('zip-dest-');
    assert.equal(spawnSync('unzip', ['-q', out, '-d', dest]).status, 0);
    assert.equal(fs.readFileSync(path.join(dest, 'x', 'y.txt'), 'utf8'), 'hello\n'.repeat(500));
  });

  it('skips symbolic links instead of failing on them', async () => {
    const src = tempDir('zip-src3-');
    const out = path.join(tempDir('zip-out3-'), 'tree.zip');
    fs.writeFileSync(path.join(src, 'real.txt'), 'r');
    try { fs.symlinkSync('real.txt', path.join(src, 'link.txt')); } catch { return; }
    await writeZipFromDir({ dir: src, out });
    assert.deepEqual(readZipEntries(out).map((m) => m.name), ['real.txt']);
  });
});

describe('the archive in zip format', () => {
  let root, srv;
  before(async () => {
    root = makeFixtureRoot();
    const app = express();
    app.use('/', createInstallRouter({ query: async () => ({ rows: [] }), auth: fakeAuth, logger: { warn() {}, error() {} }, repoRoot: root }));
    srv = await startServer(app);
  });
  after(async () => { await srv.close(); });

  it('?format=zip serves application/zip with the release header, carrying .release, install.ps1 and src/utils but no server code', async () => {
    const r = await fetch(`${srv.url}/api/install/archive?format=zip`, { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^application\/zip/);
    assert.match(r.headers.get('x-ownmind-release'), /^v\d+\.\d+\.\d+/);
    const file = path.join(tempDir('install-zip-dl-'), 'archive.zip');
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    const members = readZipEntries(file);
    const names = members.map((m) => m.name);
    assert.ok(names.includes('.release'));
    assert.equal(members.find((m) => m.name === '.release').data.toString('utf8').trim(), r.headers.get('x-ownmind-release'));
    assert.ok(names.includes('install.sh'));
    assert.ok(names.includes('install.ps1'));
    assert.ok(names.includes('hooks/a.js'));
    assert.ok(names.includes('src/utils/md-parser.js'), 'src/utils stays: the MCP server imports it');
    assert.ok(names.includes('client/package.json'));
    for (const bad of ['db', 'tests', '.git', 'client/src', 'src/routes']) {
      assert.ok(!names.some((n) => n === bad || n === `${bad}/` || n.startsWith(`${bad}/`)), `${bad} must not be packed`);
    }
    assert.ok(!names.includes('src/app.js'));
    assert.ok(!names.some((n) => n.split('/').includes('node_modules')));
    for (const secret of ['.env', '.env.production', 'mcp/server.pem']) {
      assert.ok(!names.includes(secret), `${secret} must never reach a client`);
    }
  });

  it('the default stays tar.gz, and an empty format means the default', async () => {
    const r = await fetch(`${srv.url}/api/install/archive`, { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^application\/gzip/);
    await r.arrayBuffer();
    const empty = await fetch(`${srv.url}/api/install/archive?format=`, { headers: { authorization: `Bearer ${KEY}` } });
    assert.match(empty.headers.get('content-type'), /^application\/gzip/);
    await empty.arrayBuffer();
  });

  it('an unknown format is refused, and the zip needs a key like the tar.gz does', async () => {
    const bad = await fetch(`${srv.url}/api/install/archive?format=rar`, { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'unsupported_format' });
    const anon = await fetch(`${srv.url}/api/install/archive?format=zip`);
    assert.equal(anon.status, 401);
  });

  it('buildInstallArchive builds the zip once per process and version', async () => {
    const a = await buildInstallArchive({ repoRoot: root, version: 'v9.9.8', format: 'zip' });
    try {
      assert.match(path.basename(a.path), /^ownmind-install-v9\.9\.8-[0-9a-f]{12}\.zip$/);
      // Another tree packing the same version gets a file of its own.
      const other = makeFixtureRoot();
      const c = await buildInstallArchive({ repoRoot: other, version: 'v9.9.8', format: 'zip' });
      assert.notEqual(c.path, a.path);
      fs.rmSync(c.path, { force: true });
      assert.match(a.sha256, /^[0-9a-f]{64}$/);
      const b = await buildInstallArchive({ repoRoot: root, version: 'v9.9.8', format: 'zip' });
      assert.equal(b.path, a.path);
      assert.equal(b.sha256, a.sha256);
      assert.throws(() => buildInstallArchive({ repoRoot: root, version: 'v9.9.8', format: 'rar' }), /unsupported archive format/);
    } finally {
      fs.rmSync(a.path, { force: true });
    }
  });
});
