import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { tempDir } from './helpers/temp-dir.js';

const require_ = createRequire(import.meta.url);
const { migrateApiUrl, isOldAddress, OLD_URL, NEW_URL } =
  require_('../scripts/install-helpers/migrate-api-url.cjs');

/**
 * 2026-09-14 — everyone's memories moved to a new host, and the old address only still
 * works because a proxy forwards it. That proxy is one line in one nginx file holding up
 * nine people, so the address in each machine's own config has to change. Nothing on the
 * server can reach a laptop, so the unattended updater does it.
 *
 * What these tests pin is the narrowness: the retired address is rewritten, and nothing
 * else in the file is touched — including somebody running their own OwnMind server.
 */

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

const withServer = (url) => ({ mcpServers: { ownmind: { command: 'node', env: { OWNMIND_API_URL: url, OWNMIND_API_KEY: 'k' } } } });
const readUrl = (home, rel) =>
  JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8')).mcpServers.ownmind.env.OWNMIND_API_URL;

describe('the retired address is rewritten', () => {
  it('rewrites it in .claude.json', () => {
    const home = tempHome({ '.claude.json': withServer(OLD_URL) });
    const r = migrateApiUrl({ home });
    assert.equal(r.changed, 1);
    assert.equal(readUrl(home, '.claude.json'), NEW_URL);
  });

  it('rewrites it in settings.json and settings.local.json too', () => {
    const home = tempHome({
      '.claude/settings.json': withServer(OLD_URL),
      '.claude/settings.local.json': withServer(OLD_URL),
    });
    const r = migrateApiUrl({ home });
    assert.equal(r.changed, 2);
    assert.equal(readUrl(home, '.claude/settings.json'), NEW_URL);
    assert.equal(readUrl(home, '.claude/settings.local.json'), NEW_URL);
  });

  it('rewrites the per-project copies inside .claude.json, not just the top one', () => {
    const home = tempHome({
      '.claude.json': {
        ...withServer(OLD_URL),
        projects: {
          '/Users/x/a': withServer(OLD_URL),
          '/Users/x/b': withServer(OLD_URL),
        },
      },
    });
    const r = migrateApiUrl({ home });
    assert.equal(r.changed, 3, 'a machine with two projects carries three copies of the address');
    const parsed = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(parsed.projects['/Users/x/a'].mcpServers.ownmind.env.OWNMIND_API_URL, NEW_URL);
    assert.equal(parsed.projects['/Users/x/b'].mcpServers.ownmind.env.OWNMIND_API_URL, NEW_URL);
  });

  it('a trailing slash or different casing is still the same address', () => {
    const home = tempHome({ '.claude.json': withServer('https://KKVIN.com/ownmind/') });
    assert.equal(migrateApiUrl({ home }).changed, 1);
    assert.equal(readUrl(home, '.claude.json'), NEW_URL);
  });

  it('running it twice changes nothing the second time', () => {
    const home = tempHome({ '.claude.json': withServer(OLD_URL) });
    assert.equal(migrateApiUrl({ home }).changed, 1);
    assert.equal(migrateApiUrl({ home }).changed, 0);
  });
});

describe('everything else is left alone', () => {
  it("someone running their own server keeps their address", () => {
    const own = 'https://ownmind.my-own-box.internal/ownmind';
    const home = tempHome({ '.claude.json': withServer(own) });
    assert.equal(migrateApiUrl({ home }).changed, 0);
    assert.equal(readUrl(home, '.claude.json'), own);
  });

  it('the address already on the new host is not touched', () => {
    const home = tempHome({ '.claude.json': withServer(NEW_URL) });
    assert.equal(migrateApiUrl({ home }).changed, 0);
  });

  it('other servers, other keys and unrelated settings survive the rewrite', () => {
    const home = tempHome({
      '.claude.json': {
        numStartups: 42,
        mcpServers: {
          ownmind: { command: 'node', env: { OWNMIND_API_URL: OLD_URL, OWNMIND_API_KEY: 'secret-key' } },
          other: { command: 'x', env: { SOME_URL: 'https://kkvin.com/ring' } },
        },
      },
    });
    assert.equal(migrateApiUrl({ home }).changed, 1);
    const parsed = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(parsed.numStartups, 42, 'unrelated settings must survive');
    assert.equal(parsed.mcpServers.ownmind.env.OWNMIND_API_KEY, 'secret-key', 'the key must survive');
    assert.equal(parsed.mcpServers.other.env.SOME_URL, 'https://kkvin.com/ring',
      'another service on the same old host is not ours to move');
  });

  it('a config that will not parse is reported, not rewritten, and does not throw', () => {
    const home = tempHome({ '.claude.json': '{ this is not json' });
    const r = migrateApiUrl({ home });
    assert.equal(r.changed, 0);
    assert.equal(r.files.length, 1);
    assert.ok(r.files[0].error, 'the unreadable file must be named in the report');
    assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), '{ this is not json');
  });

  it('a missing config is simply skipped', () => {
    const home = tempHome({});
    assert.deepEqual(migrateApiUrl({ home }), { changed: 0, files: [] });
  });

  it('a dry run reports the change without writing it', () => {
    const home = tempHome({ '.claude.json': withServer(OLD_URL) });
    assert.equal(migrateApiUrl({ home, dryRun: true }).changed, 1);
    assert.equal(readUrl(home, '.claude.json'), OLD_URL, 'a dry run must not touch the file');
  });
});

describe('isOldAddress', () => {
  it('matches the retired host with or without a trailing slash', () => {
    assert.equal(isOldAddress('https://kkvin.com/ownmind'), true);
    assert.equal(isOldAddress('https://kkvin.com/ownmind/'), true);
  });
  it('does not match another service on that host', () => {
    assert.equal(isOldAddress('https://kkvin.com/ring'), false);
  });
  it('does not match an empty or missing value', () => {
    assert.equal(isOldAddress(''), false);
    assert.equal(isOldAddress(undefined), false);
  });
});

/**
 * A helper nobody calls is a helper that changes nothing. Both updaters run unattended on
 * the machines this has to reach, so both have to invoke it.
 */
describe('the unattended update actually runs it', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

  it('update.sh calls migrate-api-url.cjs', () => {
    const src = read('scripts/update.sh');
    assert.match(src, /migrate-api-url\.cjs/);
    assert.match(src, /node "\$MIGRATE_URL"/, 'it must actually be executed, not only located');
  });

  it('update.ps1 calls migrate-api-url.cjs', () => {
    const src = read('scripts/update.ps1');
    assert.match(src, /migrate-api-url\.cjs/);
    assert.match(src, /&\s*node\s+\$MigrateUrl/, 'it must actually be executed, not only located');
  });

  it('the helper ships with the files the updater copies', () => {
    assert.ok(fs.existsSync(path.join(repoRoot, 'scripts/install-helpers/migrate-api-url.cjs')));
  });
});
