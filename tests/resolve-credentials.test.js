// v1.26.82 — where the API key lives, decided in one place.
//
// Adam's machine, 2026-08-06. His MCP has been running and uploading all along. His usage
// scanner died on 7/15, his memory hook has never once fired, his upgrade beacons stopped
// on 7/8, and the installer's self-check reports three failures with "OWNMIND_API_KEY is
// empty". All of it is the same cause: **every component except the MCP looks for the key
// in `~/.claude/settings.json`, and his key is not there.**
//
// The MCP does not read a file. Claude Code hands it the key in its process environment,
// so it kept working while everything else went quiet. On his machine the URL sits in
// `~/.claude.json` and the key comes from an `OWNMIND_API_KEY` environment variable.
//
// Eighteen files in this repo mention `mcpServers`; four of them stop dead when the lookup
// comes back empty. Each carries its own copy of the same wrong answer.
//
// The part that is easy to get wrong: an environment variable is not equivalent to a file.
// The usage scanner runs from Task Scheduler / launchd, which does not inherit a shell's
// environment. Finding the key in `process.env` proves the MCP can work; it proves nothing
// about the scanner. That distinction is `background_safe`, and it is the difference
// between reporting this machine as healthy and reporting what is actually wrong with it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
const { resolveCredentials } = require_(path.join(repoRoot, 'scripts/install-helpers/resolve-credentials.cjs'));

const KEY = 'k'.repeat(36);
const URL_ = 'https://kkvin.com/ownmind';

/** A throwaway HOME with only the files a case needs. */
function homeWith(files) {
  const home = tempDir('ownmind-creds-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(home, rel), JSON.stringify(body, null, 2));
  }
  return home;
}

const settingsShape = (env) => ({ mcpServers: { ownmind: { env } } });

describe('resolveCredentials — every component asks the same question', () => {
  it('finds the key in ~/.claude/settings.json, where it has always looked', () => {
    const home = homeWith({ '.claude/settings.json': settingsShape({ OWNMIND_API_KEY: KEY, OWNMIND_API_URL: URL_ }) });
    const r = resolveCredentials({ home, env: {} });
    assert.equal(r.apiKey, KEY);
    assert.equal(r.apiUrl, URL_);
    assert.equal(r.source.key, '.claude/settings.json');
    assert.equal(r.background_safe, true);
  });

  it('finds it in ~/.claude.json, which is where Claude Code keeps it now', () => {
    const home = homeWith({ '.claude.json': settingsShape({ OWNMIND_API_KEY: KEY, OWNMIND_API_URL: URL_ }) });
    const r = resolveCredentials({ home, env: {} });
    assert.equal(r.apiKey, KEY);
    assert.equal(r.source.key, '.claude.json');
    assert.equal(r.background_safe, true);
  });

  it("reproduces Adam's machine: url in a file, key only in the environment", () => {
    const home = homeWith({ '.claude.json': settingsShape({ OWNMIND_API_URL: URL_ }) });
    const r = resolveCredentials({ home, env: { OWNMIND_API_KEY: KEY } });
    assert.equal(r.apiKey, KEY, 'the key is right there in the environment');
    assert.equal(r.apiUrl, URL_);
    assert.equal(r.source.key, 'env');
    // The finding that matters. His MCP works because it is handed this environment;
    // his scanner runs from Task Scheduler and will never see it.
    assert.equal(r.background_safe, false);
  });

  it('a file beats the environment for the same field', () => {
    // A stale variable left in a shell should not silently override the configured value.
    const home = homeWith({ '.claude/settings.json': settingsShape({ OWNMIND_API_KEY: KEY, OWNMIND_API_URL: URL_ }) });
    const r = resolveCredentials({ home, env: { OWNMIND_API_KEY: 'x'.repeat(36), OWNMIND_API_URL: 'https://old' } });
    assert.equal(r.apiKey, KEY);
    assert.equal(r.apiUrl, URL_);
  });

  it('takes the two fields from wherever each one is, independently', () => {
    const home = homeWith({ '.claude.json': settingsShape({ OWNMIND_API_URL: URL_ }) });
    const r = resolveCredentials({ home, env: { OWNMIND_API_KEY: KEY } });
    assert.equal(r.source.url, '.claude.json');
    assert.equal(r.source.key, 'env');
  });

  it('prefers settings.json over .claude.json when both have one', () => {
    const home = homeWith({
      '.claude/settings.json': settingsShape({ OWNMIND_API_KEY: KEY, OWNMIND_API_URL: URL_ }),
      '.claude.json': settingsShape({ OWNMIND_API_KEY: 'y'.repeat(36), OWNMIND_API_URL: 'https://other' }),
    });
    const r = resolveCredentials({ home, env: {} });
    assert.equal(r.apiKey, KEY);
    assert.equal(r.source.key, '.claude/settings.json');
  });

  it('says nothing was found rather than throwing', () => {
    const home = homeWith({});
    const r = resolveCredentials({ home, env: {} });
    assert.equal(r.apiKey, '');
    assert.equal(r.apiUrl, '');
    assert.equal(r.source.key, null);
    assert.equal(r.background_safe, false);
  });

  it('survives a settings file that is not valid JSON', () => {
    const home = homeWith({});
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not json');
    const r = resolveCredentials({ home, env: { OWNMIND_API_KEY: KEY, OWNMIND_API_URL: URL_ } });
    assert.equal(r.apiKey, KEY, 'one broken file must not hide a key that is elsewhere');
  });

  it('never returns the key inside the diagnostic fields', () => {
    // `source` and `checked` get uploaded to the server and printed to a terminal.
    const home = homeWith({ '.claude/settings.json': settingsShape({ OWNMIND_API_KEY: KEY, OWNMIND_API_URL: URL_ }) });
    const r = resolveCredentials({ home, env: {} });
    const diagnostic = JSON.stringify({ source: r.source, checked: r.checked, background_safe: r.background_safe });
    assert.ok(!diagnostic.includes(KEY), 'a diagnostic that leaks the key cannot be uploaded');
  });

  it('reports every location it looked at, so a miss is diagnosable', () => {
    const home = homeWith({});
    const r = resolveCredentials({ home, env: {} });
    assert.ok(Array.isArray(r.checked));
    for (const where of ['env', '.claude/settings.json', '.claude.json']) {
      assert.ok(r.checked.some((c) => c.where === where), `never looked at ${where}`);
    }
  });

  it('reads this machine for real', () => {
    // Everything above is injected. This one runs against the actual configuration here,
    // which is the case that has to keep working.
    const r = resolveCredentials();
    assert.equal(typeof r.apiKey, 'string');
    assert.ok(r.checked.length >= 3);
  });
});

describe('the components that stop dead all use it', () => {
  // Following the delegation rather than grepping each file: the two hooks call
  // `readCredentials` from shared/helpers.js, and it is that function which must ask the
  // resolver. Requiring the string in every file would fail correct code and push the
  // logic back into being copied.
  const usesResolver = (rel) => {
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    if (/resolve-credentials/.test(src)) return true;
    const viaHelpers = /import\s*\{[^}]*\breadCredentials\b[^}]*\}\s*from\s*['"][^'"]*shared\/helpers\.js['"]/.test(src);
    if (!viaHelpers) return false;
    const helpers = fs.readFileSync(path.join(repoRoot, 'shared/helpers.js'), 'utf8');
    return /resolve-credentials/.test(helpers);
  };

  // These four return early or throw when the lookup is empty. On Adam's machine all four
  // did exactly that, every day, while his MCP kept working and said nothing.
  for (const rel of [
    'scripts/install-helpers/self-check.cjs',
    'hooks/ownmind-usage-scanner.js',
    'hooks/ownmind-session-start.js',
  ]) {
    it(`${rel} asks the resolver`, () => {
      assert.ok(usesResolver(rel), `${rel} still carries its own copy of the wrong answer`);
    });
  }

  it('the bash hook asks it too', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'hooks/ownmind-session-start.sh'), 'utf8');
    assert.match(src, /resolve-credentials/,
      'the shell hook reads settings.json inline; that is the same bug in another language');
  });
});
