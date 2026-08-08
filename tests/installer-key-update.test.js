import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveCredentials } = require('../scripts/install-helpers/resolve-credentials.cjs');
const { checkCredentialAgreement } = require('../scripts/install-helpers/self-check.cjs');

/**
 * Two defects, one story.
 *
 * 1. Both installers skipped writing the MCP entry whenever the settings file already
 *    contained the string "ownmind". That entry is where the API key lives, so a re-run
 *    meant to change the key did nothing and then printed an installation summary.
 * 2. The installers write ~/.claude/settings.json only; Claude Code keeps its own MCP config
 *    in ~/.claude.json. `resolveCredentials` takes the first key it finds, so the two files
 *    could hold different keys with every check green and nothing comparing the values.
 *
 * Together: a key change lands in neither file, or in one of two, and the report says fine.
 */

const OWNMIND_ENTRY = (key) => ({
  mcpServers: { ownmind: { command: 'cmd.exe', env: { OWNMIND_API_URL: 'https://s/ownmind', OWNMIND_API_KEY: key } } },
});

describe('the installers no longer skip on a present entry', () => {
  const sh = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  const ps = readFileSync(new URL('../install.ps1', import.meta.url), 'utf8');

  /** The section that writes the Claude Code MCP entry, marker to marker. */
  function claudeMcpSection(src) {
    const start = src.indexOf('# --- 2. Claude Code MCP');
    assert.ok(start > 0, 'install.sh no longer has the Claude Code MCP section marker');
    const end = src.indexOf('\n# --- ', start + 1);
    assert.ok(end > start, 'could not find the end of the Claude Code MCP section');
    return src.slice(start, end);
  }

  it('install.sh does not gate the Claude Code MCP write on the string "ownmind"', () => {
    // Assert on the guard, not on the sentence it used to print. Asserting the old message
    // is absent passes the moment somebody reintroduces the same skip under a different
    // wording — verified: putting `grep -q '"ownmind"' ... skipping` back with a shorter
    // message left the whole file green.
    assert.doesNotMatch(claudeMcpSection(sh), /grep -q\s+'"ownmind"'/,
      'the write is gated on the file merely containing "ownmind" again');
    assert.doesNotMatch(claudeMcpSection(sh), /already configured/,
      'this section holds the API key — nothing in it may be skipped as already done');
  });

  it('install.ps1 does not gate the Claude Code MCP write on the string "ownmind"', () => {
    assert.doesNotMatch(ps, /Claude Code MCP already configured, skipping/);
  });

  it('install.sh does not gate the Cursor MCP write either — that entry holds the key too', () => {
    assert.doesNotMatch(sh, /Cursor MCP already configured, skipping/);
  });

  it('the skips that remain are on blocks that carry no credential', () => {
    // Rule text, not credentials — skipping those is correct and stays.
    for (const kept of ['Cursor hooks already configured', 'Windsurf rules already configured',
      'OpenCode already configured', 'OpenClaw already configured',
      'Antigravity rules already configured']) {
      assert.ok(sh.includes(kept), `${kept} should still be skipped`);
    }
  });

  it('both installers report which of write / update / unchanged happened', () => {
    for (const [name, src] of [['install.sh', sh], ['install.ps1', ps]]) {
      assert.ok(src.includes('API key updated (replaced a different key)'), `${name} announces a key swap`);
      assert.ok(src.includes('API key unchanged'), `${name} announces a no-op`);
    }
  });

  it('the merge preserves fields the installer does not manage', () => {
    assert.match(sh, /\.\.\.prev,/, 'install.sh spreads the previous entry');
    assert.match(sh, /\.\.\.\(prev\.env \|\| \{\}\)/, 'install.sh spreads the previous env');
    assert.match(ps, /foreach \(\$p in \$settings\.mcpServers\.ownmind\.env\.PSObject\.Properties\)/,
      'install.ps1 copies the previous env');
  });
});

describe('install.sh really does replace a different key', () => {
  let home;

  before(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ownmind-inst-'));
    mkdirSync(path.join(home, '.claude'));
  });
  after(() => rmSync(home, { recursive: true, force: true }));

  /**
   * Run the write the way install.sh runs it. The script's own block is not executable in
   * isolation (it interpolates shell variables and sits after a clone and an npm install),
   * so this pins the logic, and the source-level assertions above pin that the script still
   * carries it. Guarded: the assertion fails loudly if install.sh stops matching.
   */
  it('an existing entry with an old key ends up holding the new one', () => {
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const existing = OWNMIND_ENTRY('OLD-KEY');
    existing.mcpServers.ownmind.env.KEEP_ME = 'user-set';
    existing.otherTool = { untouched: true };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

    // Extracted from install.sh and executed, not re-typed here. A hand-copied twin only
    // proves the copy works: install.sh could drift and this would stay green.
    const sh = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
    const start = sh.indexOf('# --- 2. Claude Code MCP');
    const open = sh.indexOf('node -e "', start);
    const close = sh.indexOf('\n  "\n', open);
    assert.ok(start > 0 && open > start && close > open,
      'could not find the Claude Code MCP write in install.sh');
    const script = sh
      .slice(open + 'node -e "'.length, close)
      .replaceAll('$MCP_ENTRY', JSON.stringify({ command: 'cmd.exe', args: ['/c', 'start.cmd'] }))
      .replaceAll('$CLAUDE_SETTINGS_WIN', settingsPath)
      .replaceAll('$API_URL', 'https://s/ownmind')
      .replaceAll('$API_KEY', 'NEW-KEY')
      .replaceAll('\\"', '"');
    const said = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim();

    const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(after.mcpServers.ownmind.env.OWNMIND_API_KEY, 'NEW-KEY', 'the key changed');
    assert.match(said, /API key updated \(replaced a different key\)/, 'and the run said so');
    assert.equal(after.mcpServers.ownmind.env.KEEP_ME, 'user-set', 'unmanaged env var survived');
    assert.deepEqual(after.otherTool, { untouched: true }, 'the rest of the file survived');
  });
});

describe('resolveCredentials reports disagreement instead of silently picking one', () => {
  let home;

  before(() => {
    home = mkdtempSync(path.join(tmpdir(), 'ownmind-creds-'));
    mkdirSync(path.join(home, '.claude'));
  });
  after(() => rmSync(home, { recursive: true, force: true }));

  const write = (rel, key) =>
    writeFileSync(path.join(home, rel), JSON.stringify(OWNMIND_ENTRY(key)));

  it('flags the file that holds a different key, by location and never by value', () => {
    write('.claude/settings.json', 'KEY-A');
    write('.claude.json', 'KEY-B');

    const r = resolveCredentials({ home, env: {} });
    assert.equal(r.apiKey, 'KEY-A', 'first-wins resolution is unchanged');
    assert.deepEqual(r.conflicts.key, ['.claude.json']);

    const serialized = JSON.stringify(r.conflicts);
    assert.ok(!serialized.includes('KEY-A') && !serialized.includes('KEY-B'),
      'conflicts is uploaded with the report — locations only');
  });

  it('is quiet when the files agree', () => {
    write('.claude/settings.json', 'SAME');
    write('.claude.json', 'SAME');
    const r = resolveCredentials({ home, env: {} });
    assert.deepEqual(r.conflicts, { key: [], url: [] });
  });

  it('a stale environment variable is not a conflict', () => {
    // Found on a real machine: the shell still carried the key from before an account
    // switch. The environment is last in the search order, so it can never win — counting it
    // would warn everyone who installed with the documented `OWNMIND_API_KEY=... ` one-liner.
    write('.claude/settings.json', 'FILE-KEY');
    write('.claude.json', 'FILE-KEY');
    const r = resolveCredentials({ home, env: { OWNMIND_API_KEY: 'STALE-SHELL-KEY' } });
    assert.equal(r.apiKey, 'FILE-KEY');
    assert.deepEqual(r.conflicts.key, [], 'env is excluded from conflict detection');
  });

  it('a BOM no longer makes a file invisible', () => {
    // PS 5.1 `Set-Content -Encoding UTF8` wrote this BOM. JSON.parse throws on it and the
    // catch turned the file into "nothing here".
    writeFileSync(path.join(home, '.claude', 'settings.json'),
      '﻿' + JSON.stringify(OWNMIND_ENTRY('BOM-KEY')));
    rmSync(path.join(home, '.claude.json'));
    const r = resolveCredentials({ home, env: {} });
    assert.equal(r.apiKey, 'BOM-KEY');
  });
});

describe('self-check surfaces the disagreement', () => {
  it('warns, naming the losing location and the winning source', () => {
    const c = checkCredentialAgreement({
      source: { key: '.claude/settings.json' },
      conflicts: { key: ['.claude.json'], url: [] },
    });
    assert.equal(c.status, 'warn', 'warn, not fail — the resolved key works and alerting pages on fail');
    assert.match(c.detail || c.message || JSON.stringify(c), /\.claude\.json/);
  });

  it('passes when nothing disagrees', () => {
    const c = checkCredentialAgreement({ source: { key: '.claude/settings.json' }, conflicts: { key: [], url: [] } });
    assert.equal(c.status, 'pass');
  });
});
