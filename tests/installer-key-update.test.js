import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { toWinPath } from './helpers/bash-script.js';
import { tempDir } from './helpers/temp-dir.js';

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

  /**
   * v1.26.134 — the third defect in the same story.
   *
   * Both installers reported on `prevKey` vs `nextKey`: what the run intended, never what
   * landed. Thirty lines below, the same key going into ~/.claude.json is confirmed by
   * reading the file back and says so in the message. Two halves of one credential write,
   * two standards of evidence — and the unverified half is ~/.claude/settings.json, the file
   * every hook reads its key from and one of the two locations an account switch must change.
   *
   * The silent-corruption path that makes it more than a technicality is PowerShell's
   * ConvertTo-Json: exceeding -Depth is a warning, not an error. Measured on 5.1 with
   * $ErrorActionPreference = 'Stop', `-Depth 3` on a four-level object wrote
   * {"a":{"b":{"c":{"d":"System.Collections.Hashtable"}}}} — a corrupt settings file, and the
   * installer would still have printed "API key updated".
   */
  it('both installers read the settings file back before reporting', () => {
    // Flags between -Raw and the pipe are the read's business, not this test's: -Encoding UTF8
    // was added there so a cp950 machine does not decode the file wrong on the way back in.
    assert.match(ps, /\$landed = \(Get-Content \$ClaudeSettings -Raw[^|]*\| ConvertFrom-Json\)/,
      'install.ps1 reports on its own intent again, without reading the file back');
    assert.match(sh, /landed = JSON\.parse\(fs\.readFileSync\(p, 'utf8'\)\)/,
      'install.sh reports on its own intent again, without reading the file back');
  });

  it('and both say so when the key is not there afterwards', () => {
    // A write that did not land must not be reported as one that did. Neither may be silent
    // about it either: this is the condition the whole rule exists for.
    assert.match(ps, /the API key is NOT in \$ClaudeSettings after writing it/,
      'install.ps1 has no message for a key that did not land');
    assert.match(sh, /the API key is NOT in/,
      'install.sh has no message for a key that did not land');
  });

  it('install.ps1 serialises at a depth PowerShell cannot silently truncate', () => {
    // -Depth 10 against a file that is already five levels deep before the user adds a hook.
    // 100 is the maximum the cmdlet accepts, and exceeding it is the only case that warns.
    assert.doesNotMatch(ps, /ConvertTo-Json -Depth 10\)/,
      'a settings write is back on -Depth 10, which truncates deep structures into a string');
    assert.ok((ps.match(/ConvertTo-Json -Depth 100\)/g) || []).length >= 4,
      'not every settings/MCP write was raised off the truncating depth');
  });

  it('the completion banner comes after the checks, in both installers', () => {
    // install.sh could print "OwnMind installation complete" and then, further down,
    // "[FAIL] Installation did not complete." — one run contradicting itself, claim first.
    //
    // Comments are stripped first: both files now explain this reorder in prose that quotes
    // the banner text, and an indexOf against the raw source finds the explanation.
    const shCode = sh.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const psCode = ps.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

    const shBanner = shCode.indexOf('OwnMind installation complete');
    const shCheck = shCode.indexOf('$SELF_CHECK_SCRIPT" --trigger=post_install');
    assert.ok(shCheck > 0 && shBanner > shCheck,
      'install.sh declares success before the self-check has run');

    const psBanner = psCode.indexOf('OwnMind installation complete');
    const psCheck = psCode.indexOf('$SelfCheckScript --trigger=post_install');
    assert.ok(psCheck > 0 && psBanner > psCheck,
      'install.ps1 declares success before the self-check has run');
  });

  it('install.ps1 says something when the self-check itself cannot run', () => {
    // `try { … } catch { }` around it meant a self-check that threw produced no output at all,
    // and the run still read as complete.
    const psCheckIdx = ps.indexOf('$SelfCheckScript --trigger=post_install');
    const after = ps.slice(psCheckIdx, psCheckIdx + 400);
    assert.match(after, /self-check could not run/,
      'a self-check that throws is swallowed again');
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
    home = tempDir('ownmind-inst-');
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
      // toWinPath, because that is what install.sh puts in the variable: the block reads
      // `$(to_win_path "$CLAUDE_SETTINGS")`, i.e. `cygpath -m` output, which uses forward
      // slashes. Substituting a native backslash path here fed the extracted source a
      // string the JS parser eats — a failure about the test's own input, not the code.
      .replaceAll('$CLAUDE_SETTINGS_WIN', toWinPath(settingsPath))
      .replaceAll('$API_URL', 'https://s/ownmind')
      .replaceAll('$API_KEY', 'NEW-KEY')
      .replaceAll('\\"', '"');
    const said = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim();

    const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(after.mcpServers.ownmind.env.OWNMIND_API_KEY, 'NEW-KEY', 'the key changed');
    // v1.26.134: the "verified" wording is only reachable through the branch that re-read the
    // file and compared, so asserting it here proves the read-back actually ran rather than
    // just being present in the source.
    assert.match(said, /API key updated \(replaced a different key\), verified by reading it back/,
      'the run reported the swap without confirming it against the file');
    assert.equal(after.mcpServers.ownmind.env.KEEP_ME, 'user-set', 'unmanaged env var survived');
    assert.deepEqual(after.otherTool, { untouched: true }, 'the rest of the file survived');
  });
});

describe('resolveCredentials reports disagreement instead of silently picking one', () => {
  let home;

  before(() => {
    home = tempDir('ownmind-creds-');
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
