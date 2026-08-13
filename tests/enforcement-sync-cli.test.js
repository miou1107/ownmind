import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { FETCH_BLOCKED_PORTS } from './helpers/app-server.js';
import { readEnforcementBundle } from '../hooks/lib/enforcement-cache.js';
import { syncEnforcementBundle } from '../hooks/lib/conditional-sync-cli.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(repoRoot, 'hooks', 'lib', 'conditional-sync-cli.js');

/**
 * The bundle reaches the machine, written by the code that actually runs there.
 *
 * The sync lives in this CLI and not in `ownmind-session-start.js` because this is what both
 * platforms execute: `session-hook-command.cjs` registers the `.sh` on macOS and Linux, the
 * `.sh` calls this file, and the `.js` session hook is Windows-only. A sync written into the
 * `.js` would never run on the machine it was written for, and the cache would stay empty
 * for ever with nothing reporting a problem.
 *
 * Two levels, because neither alone is enough:
 *
 *   - The behaviour is driven in-process against a real HTTP server, through the real fetch,
 *     the real writer and the real reader. Nothing here is a fake of something this repo owns.
 *   - That the CLI's `main()` actually calls it is proved by running the CLI as a program and
 *     reading the line it leaves in the sync log. That is the process boundary, and it is the
 *     part a unit test cannot see.
 */

async function startStubServer(bundle, { status = 200 } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(bundle ?? {}));
  });

  let port;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address()?.port;
    if (port && !FETCH_BLOCKED_PORTS.has(port)) break;
    await new Promise((resolve) => server.close(resolve));
    port = undefined;
  }
  if (!port) throw new Error('stub server: no dialable port');
  return { url: `http://127.0.0.1:${port}`, hits, close: () => server.close() };
}

const BUNDLE = {
  selectors: [
    { id: 412, type: 'team_standard', tags: ['trigger:ci'], keywords: ['FAPA'], always_check: false, repo_match: 'shared-monorepo' },
    { id: 125, type: 'iron_rule', tags: ['trigger:always'], keywords: [], always_check: true, repo_match: '' },
  ],
  guards: [
    { id: 412, title: 'ci ownership', repo_match: 'shared-monorepo', paths: ['ci/**'], owner: 'Colleague' },
  ],
  injectables: [
    { id: 412, title: 'ci ownership', content: 'NEVER edit ci/projects.yml.', keywords: ['FAPA'], always_check: false, repo_match: 'shared-monorepo', paths: ['ci/**'], owner: 'Colleague' },
  ],
};

const EMPTY = { selectors: [], guards: [], injectables: [] };

function cacheIn(dir) {
  return path.join(dir, 'enforcement.json');
}

test('the sync asks the right endpoint and writes a cache the real reader can read', async () => {
  const cache = cacheIn(tempDir('om-sync-'));
  const server = await startStubServer(BUNDLE);
  const logged = [];
  try {
    const outcome = await syncEnforcementBundle(server.url, 'test-key', { cachePath: cache, log: (m) => logged.push(m) });
    assert.equal(outcome, 'written');
    assert.deepEqual(server.hits, ['/api/memory/enforcement-bundle']);

    const read = readEnforcementBundle(cache);
    assert.equal(read.present, true);
    assert.deepEqual(read.guards.map((g) => g.id), [412]);
    assert.deepEqual(read.selectors.map((s) => s.id).sort((a, b) => a - b), [125, 412]);
    assert.match(read.injectables[0].content, /NEVER edit ci\/projects\.yml/);
    assert.match(logged.join('\n'), /2 selectors, 1 guards, 1 injectables/);
  } finally {
    server.close();
  }
});

test('a failing endpoint leaves an existing cache alone and says so', async () => {
  const cache = cacheIn(tempDir('om-sync-'));
  const good = await startStubServer(BUNDLE);
  try {
    await syncEnforcementBundle(good.url, 'k', { cachePath: cache, log: () => {} });
  } finally {
    good.close();
  }

  const bad = await startStubServer(null, { status: 500 });
  const logged = [];
  try {
    const outcome = await syncEnforcementBundle(bad.url, 'k', { cachePath: cache, log: (m) => logged.push(m) });
    assert.equal(outcome, 'fetch_failed');
    assert.deepEqual(
      readEnforcementBundle(cache).guards.map((g) => g.id), [412],
      'an outage must not empty the cache - a stale rule still enforces something',
    );
    assert.match(logged.join('\n'), /fetch failed/);
  } finally {
    bad.close();
  }
});

test('an empty response does not overwrite a populated cache', async () => {
  const cache = cacheIn(tempDir('om-sync-'));
  const good = await startStubServer(BUNDLE);
  try {
    await syncEnforcementBundle(good.url, 'k', { cachePath: cache, log: () => {} });
  } finally {
    good.close();
  }

  const empty = await startStubServer(EMPTY);
  const logged = [];
  try {
    const outcome = await syncEnforcementBundle(empty.url, 'k', { cachePath: cache, log: (m) => logged.push(m) });
    assert.equal(outcome, 'refused');
    assert.deepEqual(readEnforcementBundle(cache).guards.map((g) => g.id), [412]);
    assert.match(logged.join('\n'), /empty response refused/);
  } finally {
    empty.close();
  }
});

test('an account with nothing annotated still gets a cache, on a machine that had none', async () => {
  // "Synced, nothing to enforce" has to be writable, or `present` could never become true
  // for such an account and every turn would report the machine as unsynced.
  const cache = cacheIn(tempDir('om-sync-'));
  const server = await startStubServer(EMPTY);
  try {
    assert.equal(await syncEnforcementBundle(server.url, 'k', { cachePath: cache, log: () => {} }), 'written');
    assert.equal(readEnforcementBundle(cache).present, true);
  } finally {
    server.close();
  }
});

test('the CLI run as a program reaches the sync', () => {
  // The process boundary. An unreachable address is enough: what is being proved is that
  // main() gets as far as calling the sync at all, which is the half that broke when the
  // same code was written into the Windows-only hook.
  const home = tempDir('om-sync-home-');
  execFileSync('node', [CLI, 'http://127.0.0.1:1/unreachable', 'test-key'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 60_000,
  });
  const log = fs.readFileSync(path.join(home, '.ownmind', 'logs', 'sync.log'), 'utf8');
  assert.match(log, /enforcement bundle: fetch failed/,
    'main() never reached syncEnforcementBundle');
});

test('importing the CLI does not run it', async () => {
  // The export exists so the behaviour above can be driven in-process. Without the
  // run-as-a-program guard, importing it would start a sync and exit the test runner.
  const mod = await import('../hooks/lib/conditional-sync-cli.js');
  assert.deepEqual(Object.keys(mod), ['syncEnforcementBundle']);
});
