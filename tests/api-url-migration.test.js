import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { tempDir } from './helpers/temp-dir.js';

const require_ = createRequire(import.meta.url);
const { followServerMove, rewriteTo, readCurrent, askServerForCanonicalUrl, sameAddress } =
  require_('../scripts/install-helpers/migrate-api-url.cjs');

/**
 * A server that moves host cannot move its clients: the address lives in each machine's own
 * config file. So the server names where it should be reached (`canonical_url` on the init
 * response) and the unattended update follows it.
 *
 * What these tests pin is that following is the exception, not the rule. Anything short of
 * a clear answer from the server — no field, an unreachable server, a value that is not an
 * https address — leaves every config untouched, because this runs unattended on machines
 * nobody is watching.
 */

const OLD = 'https://old.example/ownmind';
const NEW = 'https://new.example/ownmind';

function tempHome(files) {
  const home = tempDir('ownmind-url-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return home;
}

const withServer = (url) => ({
  mcpServers: { ownmind: { command: 'node', env: { OWNMIND_API_URL: url, OWNMIND_API_KEY: 'k' } } },
});
const readUrl = (home, rel) =>
  JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8')).mcpServers.ownmind.env.OWNMIND_API_URL;

/** A server that answers init with whatever `canonical` is given. */
const serverSaying = (canonical, { ok = true } = {}) => async () => ({
  ok,
  json: async () => ({ server_version: '1.0.0', canonical_url: canonical }),
});

describe('the server says it moved', () => {
  it('every config on the machine follows it', async () => {
    const home = tempHome({
      '.claude.json': withServer(OLD),
      '.claude/settings.json': withServer(OLD),
    });
    const r = await followServerMove({ home, canonicalUrl: NEW });
    assert.equal(r.changed, 2);
    assert.equal(r.to, NEW);
    assert.equal(readUrl(home, '.claude.json'), NEW);
    assert.equal(readUrl(home, '.claude/settings.json'), NEW);
  });

  it('the per-project copies follow too, not just the top-level one', async () => {
    const home = tempHome({
      '.claude.json': { ...withServer(OLD), projects: { '/x/a': withServer(OLD), '/x/b': withServer(OLD) } },
    });
    const r = await followServerMove({ home, canonicalUrl: NEW });
    assert.equal(r.changed, 3, 'a machine with two projects carries three copies of the address');
    const parsed = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(parsed.projects['/x/a'].mcpServers.ownmind.env.OWNMIND_API_URL, NEW);
    assert.equal(parsed.projects['/x/b'].mcpServers.ownmind.env.OWNMIND_API_URL, NEW);
  });

  it('it is asked over the network, not guessed', async () => {
    let asked = null;
    const fetchImpl = async (url, init) => {
      asked = { url, auth: init.headers.Authorization };
      return { ok: true, json: async () => ({ canonical_url: NEW }) };
    };
    const home = tempHome({ '.claude.json': withServer(OLD) });
    const r = await followServerMove({ home, fetchImpl });
    assert.match(asked.url, /^https:\/\/old\.example\/ownmind\/api\/memory\/init/);
    assert.equal(asked.auth, 'Bearer k', 'the request has to be authenticated to get an answer');
    assert.equal(r.changed, 1);
  });

  it('running it again after the move changes nothing', async () => {
    const home = tempHome({ '.claude.json': withServer(OLD) });
    assert.equal((await followServerMove({ home, canonicalUrl: NEW })).changed, 1);
    assert.equal((await followServerMove({ home, canonicalUrl: NEW })).changed, 0);
  });
});

describe('anything short of a clear answer changes nothing', () => {
  const cases = [
    ['the server names no address', ''],
    ['the field is missing', undefined],
    ['the field is not a URL', 'somewhere else'],
    ['the address is not https', 'http://new.example/ownmind'],
    ['the server names the address we already use', OLD],
  ];
  for (const [label, canonical] of cases) {
    it(label, async () => {
      const home = tempHome({ '.claude.json': withServer(OLD) });
      const r = await followServerMove({ home, fetchImpl: serverSaying(canonical) });
      assert.equal(r.changed, 0);
      assert.equal(readUrl(home, '.claude.json'), OLD);
    });
  }

  it('the server cannot be reached', async () => {
    const home = tempHome({ '.claude.json': withServer(OLD) });
    const fetchImpl = async () => { throw new Error('fetch failed'); };
    const r = await followServerMove({ home, fetchImpl });
    assert.equal(r.changed, 0);
    assert.equal(readUrl(home, '.claude.json'), OLD);
  });

  it('the server answers with an error status', async () => {
    const home = tempHome({ '.claude.json': withServer(OLD) });
    const r = await followServerMove({ home, fetchImpl: serverSaying(NEW, { ok: false }) });
    assert.equal(r.changed, 0);
  });

  it('this machine has no config at all', async () => {
    const home = tempHome({});
    const r = await followServerMove({ home, canonicalUrl: NEW });
    assert.equal(r.changed, 0);
  });
});

describe('everything else in the file is left alone', () => {
  it('another server entry keeps its own settings', async () => {
    const home = tempHome({
      '.claude.json': {
        numStartups: 42,
        mcpServers: {
          ownmind: { command: 'node', env: { OWNMIND_API_URL: OLD, OWNMIND_API_KEY: 'secret-key' } },
          other: { command: 'x', env: { SOME_URL: OLD } },
        },
      },
    });
    assert.equal((await followServerMove({ home, canonicalUrl: NEW })).changed, 1);
    const parsed = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(parsed.numStartups, 42);
    assert.equal(parsed.mcpServers.ownmind.env.OWNMIND_API_KEY, 'secret-key');
    assert.equal(parsed.mcpServers.other.env.SOME_URL, OLD, 'another service is not ours to move');
  });

  it('a config that will not parse is reported, not rewritten', () => {
    const home = tempHome({ '.claude.json': '{ this is not json' });
    const r = rewriteTo(OLD, NEW, { home });
    assert.equal(r.changed, 0);
    assert.ok(r.files[0].error, 'the unreadable file must be named in the report');
    assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), '{ this is not json');
  });

  it('a dry run reports the change without writing it', async () => {
    const home = tempHome({ '.claude.json': withServer(OLD) });
    const r = await followServerMove({ home, canonicalUrl: NEW, dryRun: true });
    assert.equal(r.changed, 1);
    assert.equal(readUrl(home, '.claude.json'), OLD);
  });
});

describe('the small parts', () => {
  it('readCurrent finds the address and the key', () => {
    const home = tempHome({ '.claude/settings.json': withServer(OLD) });
    assert.deepEqual(readCurrent(home), { url: OLD, key: 'k' });
  });

  it('askServerForCanonicalUrl returns nothing when there is no key to ask with', async () => {
    assert.equal(await askServerForCanonicalUrl({ url: OLD, key: '' }), '');
  });

  it('a trailing slash or different case is the same address', () => {
    assert.equal(sameAddress('https://A.example/ownmind/', 'https://a.example/ownmind'), true);
    assert.equal(sameAddress('https://a.example/ownmind', 'https://b.example/ownmind'), false);
    assert.equal(sameAddress('', ''), false, 'two empty values are not an address');
  });
});

/** A helper nobody calls changes nothing, and both updaters run on the machines this reaches. */
describe('the unattended update actually runs it', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

  it('update.sh calls it', () => {
    assert.match(read('scripts/update.sh'), /node "\$MIGRATE_URL"/);
  });

  it('update.ps1 calls it', () => {
    assert.match(read('scripts/update.ps1'), /&\s*node\s+\$MigrateUrl/);
  });

  it('the server publishes the field the client reads', () => {
    assert.match(read('src/routes/memory.js'), /canonical_url: process\.env\.CANONICAL_URL/);
  });

  it('no server address is written into the repository', () => {
    const src = read('scripts/install-helpers/migrate-api-url.cjs');
    assert.doesNotMatch(src, /https:\/\/(?!\$|\{)[a-z0-9.-]+\.[a-z]{2,}/i,
      'the address has to come from the server at runtime, never from this file');
  });
});
