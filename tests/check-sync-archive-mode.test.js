// check-sync on an archive install (a .release file and no .git): its L1 line compares the
// release with what the OwnMind server ships, and never says not_git. Runs the real
// scripts/check-sync.sh against a local server; check-sync.ps1 gets the static checks.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'check-sync-archive-key';
const skip = process.platform === 'win32' ? 'check-sync.sh is the Mac/Linux script' : false;

const server = { http: null, url: '', release: 'v1.34.0', heads: [] };

before(async () => {
  server.http = http.createServer((req, res) => {
    if (req.url === '/api/install/archive' && req.method === 'HEAD') {
      server.heads.push(req.headers.authorization || '');
      if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); return res.end(); }
      res.writeHead(200, { 'x-ownmind-release': server.release });
      return res.end();
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => server.http.listen(0, '127.0.0.1', resolve));
  server.url = `http://127.0.0.1:${server.http.address().port}`;
});
after(() => new Promise((resolve) => server.http.close(resolve)));

/** A HOME with an archive install of `release` whose scripts are the ones under test. */
function archiveHome(release) {
  const home = tempDir('check-sync-archive-');
  const dir = path.join(home, '.ownmind');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.release'), `${release}\n`);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: release.slice(1) }));
  for (const name of ['shared', 'scripts']) fs.symlinkSync(path.join(repoRoot, name), path.join(dir, name));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    mcpServers: { ownmind: { env: { OWNMIND_API_KEY: KEY, OWNMIND_API_URL: server.url } } },
  }));
  return home;
}

/** Spawned, not spawnSync'd: the server above answers on this process's event loop. */
function checkSync(home) {
  return new Promise((resolve, reject) => {
    // The key and URL must come from the settings file above, not from a developer's shell.
    const { OWNMIND_API_KEY, OWNMIND_API_URL, ...env } = process.env;
    const child = spawn('bash', [path.join(repoRoot, 'scripts', 'check-sync.sh')], {
      env: { ...env, HOME: home, USERPROFILE: home, OWNMIND_DIR: path.join(home, '.ownmind'), CLAUDE_DIR: path.join(home, '.claude') },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', () => {});
    child.once('error', reject);
    child.once('close', () => resolve(out));
  });
}

const l1 = (out) => out.split('\n').find((l) => l.startsWith('L1_REMOTE:'));

describe('check-sync.sh on an archive install', { skip }, () => {
  it('same release as the server: L1_REMOTE:in_sync release=v1.34.0', async () => {
    server.release = 'v1.34.0';
    server.heads = [];
    const out = await checkSync(archiveHome('v1.34.0'));
    assert.equal(l1(out), 'L1_REMOTE:in_sync release=v1.34.0', out);
    assert.equal(server.heads[0], `Bearer ${KEY}`);
  });

  it('older than the server: behind, with both releases, and OVERALL asks for the upgrade', async () => {
    server.release = 'v1.35.2';
    const out = await checkSync(archiveHome('v1.34.0'));
    assert.equal(l1(out), 'L1_REMOTE:behind release=v1.34.0 server=v1.35.2', out);
    assert.match(out, /^OVERALL:needs_upgrade$/m);
  });

  it('server not reachable: an error with the release, never not_git', async () => {
    const home = archiveHome('v1.34.0');
    const settings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({
      mcpServers: { ownmind: { env: { OWNMIND_API_KEY: 'wrong-key', OWNMIND_API_URL: server.url } } },
    }));
    const out = await checkSync(home);
    assert.match(l1(out), /^L1_REMOTE:error release=v1\.34\.0 reason=http_401$/, out);
    assert.doesNotMatch(out, /not_git/);
  });
});

describe('update-to-release.mjs on an archive install', () => {
  const helper = path.join(repoRoot, 'scripts', 'install-helpers', 'update-to-release.mjs');

  it('--print prints the .release value', () => {
    const dir = tempDir('update-to-release-archive-');
    fs.writeFileSync(path.join(dir, '.release'), 'v1.34.0\n');
    const r = spawnSync(process.execPath, [helper, '--dir', dir, '--print'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'v1.34.0');
  });

  it('a move is refused with a pointer to the server update', () => {
    const dir = tempDir('update-to-release-archive-');
    fs.writeFileSync(path.join(dir, '.release'), 'v1.34.0\n');
    const r = spawnSync(process.execPath, [helper, '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /archive install v1\.34\.0: updates come from the OwnMind server/);
  });
});

describe('check-sync.ps1 has the same archive branch', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'scripts', 'check-sync.ps1'), 'utf8');
  it('asks the archive helper before looking for a checkout', () => {
    const archive = src.indexOf("if (-not (Test-Path $gitDir) -and ((Test-Path $releaseFile) -or (Test-Path (Join-Path $OwnmindDir '.swap-journal.json')))) {");
    const checkout = src.indexOf('} elseif (Test-Path $gitDir) {');
    assert.ok(archive > 0 && checkout > archive, 'the archive branch must come first');
    assert.match(src, /& node \$archiveHelper --dir \$OwnmindDir --check/);
    assert.match(src, /\$archiveL1 -match '\^\(in_sync\|behind\) \(\.\+\)\$'/);
    assert.match(src, /\$L1Detail = "release=\$archiveRelease reason=helper_failed"/);
  });
});
