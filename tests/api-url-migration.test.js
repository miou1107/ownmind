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

/**
 * Issue #152. Claude Code was not the only tool pointing at the server: Codex, Windsurf,
 * OpenCode and Cursor each keep their own copy of the address. On the Mac in that issue,
 * Claude Code had already been moved, so asking its server "where should I be?" answered
 * "right here" and the move stopped — while the other three still named the retired host.
 * Every address on the machine has to be asked about on its own.
 */
describe('every tool on the machine follows, not only Claude Code', () => {
  /** Each server answers for itself: the retired one names the new home, the new one names itself. */
  const twoServers = (asked = []) => async (url) => {
    asked.push(url);
    const canonical = url.startsWith(OLD) ? NEW : url.startsWith(NEW) ? NEW : '';
    return { ok: true, json: async () => ({ canonical_url: canonical }) };
  };

  const codexToml = (url, { inline = false } = {}) => inline
    ? `model = "o4"\n\n[mcp_servers.ownmind]\ncommand = "node"\nargs = ["/x/mcp/index.js"]\nenv = { OWNMIND_API_URL = "${url}", OWNMIND_API_KEY = "k" }\n`
    : `model = "o4"\n\n[mcp_servers.ownmind]\ncommand = "node"\n\n[mcp_servers.ownmind.env]\nOWNMIND_API_URL = "${url}"\nOWNMIND_API_KEY = "k"\n`;
  const opencode = (url) => ({
    $schema: 'https://opencode.ai/config.json',
    mcp: { ownmind: { type: 'local', command: ['node', '/x/mcp/index.js'], environment: { OWNMIND_API_URL: url, OWNMIND_API_KEY: 'k' } } },
  });
  const readToml = (home) => fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8');

  it('Claude Code already moved; Codex, Windsurf, OpenCode and Cursor still name the old host', async () => {
    const home = tempHome({
      '.claude.json': withServer(NEW),
      '.codex/config.toml': codexToml(OLD),
      '.codeium/windsurf/mcp_config.json': withServer(OLD),
      '.config/opencode/opencode.json': opencode(OLD),
      '.cursor/mcp.json': withServer(OLD),
    });
    const r = await followServerMove({ home, fetchImpl: twoServers() });

    assert.equal(r.changed, 4);
    assert.match(readToml(home), new RegExp(`OWNMIND_API_URL = "${NEW}"`));
    assert.equal(readUrl(home, '.codeium/windsurf/mcp_config.json'), NEW);
    assert.equal(readUrl(home, '.cursor/mcp.json'), NEW);
    const oc = JSON.parse(fs.readFileSync(path.join(home, '.config/opencode/opencode.json'), 'utf8'));
    assert.equal(oc.mcp.ownmind.environment.OWNMIND_API_URL, NEW);
    assert.equal(readUrl(home, '.claude.json'), NEW);
  });

  it('the Codex env written inline is followed too, and the rest of the file is kept byte for byte', async () => {
    const before = codexToml(OLD, { inline: true });
    const home = tempHome({ '.codex/config.toml': before });
    const r = await followServerMove({ home, fetchImpl: twoServers() });
    assert.equal(r.changed, 1);
    assert.equal(readToml(home), before.replace(OLD, NEW));
  });

  it('OpenCode at the path the installer uses (~/.opencode.json) is followed', async () => {
    const home = tempHome({ '.opencode.json': opencode(OLD) });
    assert.equal((await followServerMove({ home, fetchImpl: twoServers() })).changed, 1);
  });

  it('each distinct address is asked about once, with the key stored beside it', async () => {
    const asked = [];
    const home = tempHome({
      '.claude.json': withServer(NEW),
      '.cursor/mcp.json': withServer(OLD),
      '.codeium/windsurf/mcp_config.json': withServer(OLD),
    });
    await followServerMove({ home, fetchImpl: twoServers(asked) });
    assert.equal(asked.length, 2, `asked: ${asked.join(', ')}`);
  });

  it('an address whose server names no new home is left where it is', async () => {
    const SELF = 'https://self-hosted.example/ownmind';
    const home = tempHome({ '.claude.json': withServer(NEW), '.cursor/mcp.json': withServer(SELF) });
    const r = await followServerMove({ home, fetchImpl: twoServers() });
    assert.equal(r.changed, 0);
    assert.equal(readUrl(home, '.cursor/mcp.json'), SELF);
  });

  it('an address with no key beside it is not asked about with some other tool\'s key', async () => {
    const asked = [];
    const toml = '[mcp_servers.ownmind.env]\nOWNMIND_API_URL = "' + OLD + '"\n';
    const home = tempHome({ '.claude.json': withServer(NEW), '.codex/config.toml': toml });
    const saved = process.env.OWNMIND_API_KEY;
    delete process.env.OWNMIND_API_KEY;
    try {
      const r = await followServerMove({ home, fetchImpl: twoServers(asked) });
      assert.equal(r.changed, 0);
      assert.ok(!asked.some((u) => u.startsWith(OLD)), 'a key goes only to the server it was configured for');
      assert.ok(r.skipped.some((s) => s.url === OLD), 'the address it could not check is reported, not dropped');
    } finally {
      if (saved !== undefined) process.env.OWNMIND_API_KEY = saved;
    }
  });

  it('a Codex file with two servers asks each with its own key, and a commented-out key is never used', async () => {
    const asked = [];
    const OTHER = 'https://work.example/ownmind';
    const toml = [
      '# OWNMIND_API_KEY = "stale-key"',
      '[mcp_servers.ownmind.env]',
      `OWNMIND_API_URL = "${OLD}"`,
      'OWNMIND_API_KEY = "key-a"',
      '',
      '[mcp_servers.work]',
      'command = "node"',
      `env = { OWNMIND_API_URL = "${OTHER}", OWNMIND_API_KEY = "key-b" }`,
      '',
    ].join('\n');
    const home = tempHome({ '.codex/config.toml': toml });
    const fetchImpl = async (url, init) => {
      asked.push([url.split('/api/')[0], init.headers.Authorization]);
      return { ok: true, json: async () => ({ canonical_url: url.startsWith(OLD) ? NEW : '' }) };
    };
    await followServerMove({ home, fetchImpl });
    assert.deepEqual(asked.sort(), [[OLD, 'Bearer key-a'], [OTHER, 'Bearer key-b']].sort());
  });

  it('a commented-out address is neither asked about nor rewritten', async () => {
    const asked = [];
    const toml = `[mcp_servers.ownmind.env]\n# OWNMIND_API_URL = "${OLD}"\nOWNMIND_API_URL = "${NEW}"\nOWNMIND_API_KEY = "k"\n`;
    const home = tempHome({ '.codex/config.toml': toml });
    await followServerMove({ home, fetchImpl: twoServers(asked) });
    assert.ok(!asked.some((u) => u.startsWith(OLD)));
    assert.equal(readToml(home), toml);
  });

  it('a server that answers with an address carrying a quote is not followed', async () => {
    const home = tempHome({ '.codex/config.toml': codexToml(OLD) });
    const before = readToml(home);
    const r = await followServerMove({ home, fetchImpl: serverSaying('https://new.example/"x') });
    assert.equal(r.changed, 0);
    assert.equal(readToml(home), before);
  });

  it('a config that will not parse is reported even when nothing else on the machine moves', async () => {
    const home = tempHome({ '.claude.json': withServer(NEW), '.config/opencode/opencode.json': '{ // a comment\n}' });
    const r = await followServerMove({ home, fetchImpl: twoServers() });
    assert.equal(r.changed, 0);
    assert.ok(r.files.some((f) => f.tool === 'OpenCode' && f.error), JSON.stringify(r.files));
  });

  it('a symlinked config stays a symlink, and no temporary copy is left beside it', async (t) => {
    const home = tempHome({ 'dotfiles/mcp.json': withServer(OLD) });
    fs.mkdirSync(path.join(home, '.cursor'));
    const link = path.join(home, '.cursor/mcp.json');
    try {
      fs.symlinkSync(path.join(home, 'dotfiles/mcp.json'), link, 'file');
    } catch {
      t.skip('this machine does not allow creating symlinks');
      return;
    }
    const r = await followServerMove({ home, fetchImpl: twoServers() });
    assert.equal(r.changed, 1);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link must still be a link');
    assert.equal(readUrl(home, 'dotfiles/mcp.json'), NEW, 'the file behind the link carries the new address');
    assert.deepEqual(fs.readdirSync(path.join(home, 'dotfiles')), ['mcp.json']);
  });

  it('every changed file is read back, and the report says which tool it belongs to', async () => {
    const home = tempHome({ '.codeium/windsurf/mcp_config.json': withServer(OLD) });
    const r = await followServerMove({ home, fetchImpl: twoServers() });
    assert.deepEqual(r.files.map((f) => [f.tool, f.changed, Boolean(f.verified)]), [['Windsurf', 1, true]]);
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
