/**
 * A replaced key is only half the job: every tool on every machine that held the old one
 * goes dark until it holds the new one. swap-api-key.cjs rewrites them all, reads each file
 * back, and asks the server who the new key belongs to — because an installer saying "done"
 * is not evidence the value changed (IR-001).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { tempDir } from './helpers/temp-dir.js';

const require_ = createRequire(import.meta.url);
const { swapKey, changeKey, mask } = require_('../scripts/install-helpers/swap-api-key.cjs');

const URL_ = 'https://memory.example/ownmind';
const OLD = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

function tempHome(files) {
  const home = tempDir('ownmind-key-');
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return home;
}
const server = (key) => ({ mcpServers: { ownmind: { env: { OWNMIND_API_URL: URL_, OWNMIND_API_KEY: key } } } });
const keyIn = (home, rel) => JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8')).mcpServers.ownmind.env.OWNMIND_API_KEY;

/** A server where `keys` maps a key to an account id; rotating moves the account to NEW. */
function fakeServer(keys) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const key = (init.headers?.Authorization || '').replace('Bearer ', '');
    calls.push({ url, method: init.method || 'GET', key });
    if (url.endsWith('/api/me/rotate-key')) {
      if (!(key in keys)) return { ok: false, status: 401, json: async () => ({ error: 'no' }) };
      const id = keys[key];
      delete keys[key];
      keys[NEW] = id;
      return { ok: true, status: 200, json: async () => ({ id, api_key: NEW }) };
    }
    if (url.endsWith('/api/me/profile')) {
      if (!(key in keys)) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ id: keys[key] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

describe('swapKey — every tool on the machine', () => {
  it('replaces the old key in Claude Code, Cursor, Windsurf, OpenCode and Codex, and reads each back', () => {
    const home = tempHome({
      '.claude.json': { ...server(OLD), projects: { '/p': server(OLD) } },
      '.cursor/mcp.json': server(OLD),
      '.codeium/windsurf/mcp_config.json': server(OLD),
      '.config/opencode/opencode.json': { mcp: { ownmind: { environment: { OWNMIND_API_URL: URL_, OWNMIND_API_KEY: OLD } } } },
      '.codex/config.toml': `[mcp_servers.ownmind.env]\nOWNMIND_API_URL = "${URL_}"\nOWNMIND_API_KEY = "${OLD}"\n`,
    });
    const r = swapKey(OLD, NEW, { home });
    assert.equal(r.changed, 6);
    assert.ok(r.files.every((f) => f.verified), JSON.stringify(r.files));
    assert.equal(keyIn(home, '.cursor/mcp.json'), NEW);
    assert.match(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8'), new RegExp(`OWNMIND_API_KEY = "${NEW}"`));
  });

  it('a second account\'s key elsewhere on the machine is left alone', () => {
    const home = tempHome({ '.claude.json': server(OLD), '.cursor/mcp.json': server(OTHER) });
    swapKey(OLD, NEW, { home });
    assert.equal(keyIn(home, '.claude.json'), NEW);
    assert.equal(keyIn(home, '.cursor/mcp.json'), OTHER);
  });

  it('a commented-out key in a Codex file is not touched', () => {
    const toml = `[mcp_servers.ownmind.env]\n# OWNMIND_API_KEY = "${OLD}"\nOWNMIND_API_KEY = "${OLD}"\n`;
    const home = tempHome({ '.codex/config.toml': toml });
    swapKey(OLD, NEW, { home });
    const after = fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
    assert.match(after, new RegExp(`# OWNMIND_API_KEY = "${OLD}"`));
    assert.match(after, new RegExp(`\\nOWNMIND_API_KEY = "${NEW}"`));
  });

  it('a config that will not parse is never rewritten: an error if it holds the old key, a warning if not', () => {
    const holding = `{ "OWNMIND_API_KEY": "${OLD}", }`;
    const home = tempHome({ '.cursor/mcp.json': holding, '.gemini/settings.json': '{ nope' });
    const r = swapKey(OLD, NEW, { home });
    assert.equal(r.changed, 0);
    assert.ok(r.files.find((f) => f.tool === 'Cursor').error);
    assert.ok(r.files.find((f) => f.tool === 'Gemini CLI').warning);
    assert.equal(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8'), holding);
    assert.equal(fs.readFileSync(path.join(home, '.gemini/settings.json'), 'utf8'), '{ nope');
  });
});

describe('changeKey --rotate — the server is the judge', () => {
  it('rotates, rewrites, confirms the account with the new key, and leaves no copy of the key behind', async () => {
    const home = tempHome({ '.claude.json': server(OLD) });
    const { fetchImpl, calls } = fakeServer({ [OLD]: 7 });
    const r = await changeKey({ mode: 'rotate', home, fetchImpl, credentials: { apiUrl: URL_, apiKey: OLD } });
    assert.equal(r.ok, true, r.steps.join('\n'));
    assert.equal(keyIn(home, '.claude.json'), NEW);
    assert.ok(calls.some((c) => c.url.endsWith('/api/me/profile') && c.key === NEW), 'identity checked with the new key');
    assert.equal(fs.existsSync(path.join(home, '.ownmind', 'new-api-key.txt')), false);
    assert.ok(!r.steps.join('\n').includes(NEW), 'the full key is never printed');
  });

  it('if a file holding the old key cannot be rewritten after the server rotated, the new key is kept', async () => {
    const home = tempHome({
      '.claude.json': server(OLD),
      // Holds the old key, but is not valid JSON: it cannot be rewritten safely.
      '.cursor/mcp.json': `{ "mcpServers": { "ownmind": { "env": { "OWNMIND_API_KEY": "${OLD}" } } }, }`,
    });
    const { fetchImpl } = fakeServer({ [OLD]: 7 });
    const r = await changeKey({ mode: 'rotate', home, fetchImpl, credentials: { apiUrl: URL_, apiKey: OLD } });
    assert.equal(r.ok, false);
    assert.ok(r.recoveryFile, r.steps.join('\n'));
    assert.equal(fs.readFileSync(r.recoveryFile, 'utf8').trim(), NEW);
  });

  it('a broken config of some other tool, without the old key in it, is only a warning', async () => {
    const home = tempHome({ '.claude.json': server(OLD), '.gemini/settings.json': '{ broken' });
    const { fetchImpl } = fakeServer({ [OLD]: 7 });
    const r = await changeKey({ mode: 'rotate', home, fetchImpl, credentials: { apiUrl: URL_, apiKey: OLD } });
    assert.equal(r.ok, true, r.steps.join('\n'));
  });

  it('a key that lives only in an environment variable is not rotated: the tool could not rewrite it', async () => {
    const home = tempHome({});
    const { fetchImpl, calls } = fakeServer({ [OLD]: 7 });
    const r = await changeKey({ mode: 'rotate', home, fetchImpl, credentials: { apiUrl: URL_, apiKey: OLD, source: { key: 'env' } } });
    assert.equal(r.ok, false);
    assert.match(r.steps.join('\n'), /環境變數/);
    assert.ok(!calls.some((c) => c.url.endsWith('/rotate-key')), 'nothing is rotated');
  });

  it('a rotation that rewrote nothing is a failure, and the new key is kept', async () => {
    // The old key is not in any file the tool knows (it came from somewhere else).
    const home = tempHome({ '.cursor/mcp.json': server(OTHER) });
    const { fetchImpl } = fakeServer({ [OLD]: 7 });
    const r = await changeKey({ mode: 'rotate', home, fetchImpl, credentials: { apiUrl: URL_, apiKey: OLD, source: { key: '.claude.json' } } });
    assert.equal(r.ok, false);
    assert.ok(r.recoveryFile && fs.readFileSync(r.recoveryFile, 'utf8').trim() === NEW, r.steps.join('\n'));
  });

  it('a lost answer after the server already switched says so, instead of "nothing changed"', async () => {
    const home = tempHome({ '.claude.json': server(OLD) });
    const keys = { [OLD]: 7 };
    const inner = fakeServer(keys).fetchImpl;
    const fetchImpl = async (url, init) => {
      if (url.endsWith('/rotate-key')) {
        await inner(url, init); // the server switches...
        throw new Error('The operation was aborted due to timeout'); // ...and the answer is lost
      }
      return inner(url, init);
    };
    const r = await changeKey({ mode: 'rotate', home, fetchImpl, credentials: { apiUrl: URL_, apiKey: OLD } });
    assert.equal(r.ok, false);
    assert.match(r.steps.join('\n'), /舊金鑰已經失效/);
    assert.doesNotMatch(r.steps.join('\n'), /什麼都沒改/);
  });

  it('a key the server no longer accepts is not rotated; it says to use --set', async () => {
    const home = tempHome({ '.claude.json': server(OLD) });
    const { fetchImpl, calls } = fakeServer({});
    const r = await changeKey({ mode: 'rotate', home, fetchImpl, credentials: { apiUrl: URL_, apiKey: OLD } });
    assert.equal(r.ok, false);
    assert.match(r.steps.join('\n'), /--set/);
    assert.ok(!calls.some((c) => c.url.endsWith('/rotate-key')));
    assert.equal(keyIn(home, '.claude.json'), OLD);
  });
});

describe('changeKey --set — another machine of the same person', () => {
  it('a key the server does not recognise changes nothing', async () => {
    const home = tempHome({ '.claude.json': server(OLD) });
    const { fetchImpl } = fakeServer({});
    const r = await changeKey({ mode: 'set', newKey: NEW, home, fetchImpl, credentials: { apiUrl: URL_, apiKey: OLD } });
    assert.equal(r.ok, false);
    assert.equal(keyIn(home, '.claude.json'), OLD);
  });

  it('a recognised key replaces the old one and is confirmed', async () => {
    const home = tempHome({ '.claude.json': server(OLD) });
    const { fetchImpl } = fakeServer({ [NEW]: 7 });
    const r = await changeKey({ mode: 'set', newKey: NEW, home, fetchImpl, credentials: { apiUrl: URL_, apiKey: OLD } });
    assert.equal(r.ok, true, r.steps.join('\n'));
    assert.equal(keyIn(home, '.claude.json'), NEW);
  });

  it('mask shows only the ends', () => {
    assert.equal(mask(NEW), '2222…2222');
  });
});
