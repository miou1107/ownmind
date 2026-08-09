import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  registerMcp, isRegisteredForClaudeCode, mergeEntry,
} = require_(path.join(repoRoot, 'scripts/install-helpers/register-mcp.cjs'));

/**
 * v1.26.112 — the MCP server was never registered where Claude Code looks.
 *
 * Every installer wrote `~/.claude/settings.json`. Claude Code reads that file for hooks,
 * but it launches MCP servers from `~/.claude.json`, which no installer has ever written.
 * So for nine releases the `ownmind_*` tools did not exist in anybody's session installed
 * by these scripts. Memory still appeared, because the SessionStart hook is configured in
 * `settings.json` and does its own HTTP call — which is exactly why nobody noticed: the
 * visible half worked.
 *
 * Measured 2026-08-09: a machine with a complete `mcpServers.ownmind` block in
 * `settings.json`, no `mcpServers` key at all in `.claude.json`, and no `ownmind_*` tool
 * in the session. `node ~/.ownmind/mcp/index.js` answered `initialize` correctly by hand,
 * so the server was fine; only the registration was in the wrong file.
 *
 * The first test below is the one that had to exist and did not.
 */

function fakeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-mcpreg-'));
}

const ENTRY = { command: 'cmd.exe', args: ['/c', 'C:\\Users\\x\\.ownmind\\mcp\\start.cmd'] };
const CREDS = { apiUrl: 'https://example.invalid', apiKey: 'k-test', tool: 'claude-code' };

function readJson(f) {
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function withHome(fn) {
  const home = fakeHome();
  try { return fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

describe('v1.26.112 — the MCP server is registered where Claude Code launches it', () => {
  it('writes mcpServers.ownmind into ~/.claude.json', () => {
    // The regression test for the whole defect. Writing settings.json is not enough and
    // never was; this is the file Claude Code actually launches from.
    withHome((home) => {
      const r = registerMcp({ entry: ENTRY, ...CREDS, home });
      assert.equal(r.verified, true, `not verified: ${r.problems.join('; ')}`);
      const claudeJson = readJson(path.join(home, '.claude.json'));
      assert.ok(claudeJson.mcpServers && claudeJson.mcpServers.ownmind,
        'no mcpServers.ownmind in ~/.claude.json — the tools will not exist in any session');
      assert.equal(claudeJson.mcpServers.ownmind.command, ENTRY.command);
      assert.equal(claudeJson.mcpServers.ownmind.env.OWNMIND_API_KEY, CREDS.apiKey);
    });
  });

  it('positive control: the old behaviour fails this check', () => {
    // Writing only settings.json — what every installer up to v1.26.111 did. If this ever
    // starts passing, the test above proves nothing.
    withHome((home) => {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
        JSON.stringify({ mcpServers: { ownmind: { ...ENTRY, env: {} } } }, null, 2));
      const state = isRegisteredForClaudeCode({ home });
      assert.equal(state.registered, false,
        'a machine with only settings.json must be reported as not registered');
      assert.match(state.reason, /\.claude\.json/);
    });
  });

  it('also keeps ~/.claude/settings.json in step', () => {
    // Several hooks and resolveCredentials read settings.json first. Registering in one
    // file and not the other is the account-switch disagreement v1.26.93 exists to catch.
    withHome((home) => {
      registerMcp({ entry: ENTRY, ...CREDS, home });
      const settings = readJson(path.join(home, '.claude', 'settings.json'));
      assert.equal(settings.mcpServers.ownmind.env.OWNMIND_API_KEY, CREDS.apiKey);
    });
  });

  it('does not disturb anything else already in ~/.claude.json', () => {
    // That file holds the user's whole project history. An installer that trims it to the
    // keys it understands would be far worse than the bug being fixed.
    withHome((home) => {
      const original = {
        projects: { 'C:\\work\\thing': { history: [1, 2, 3], hasTrustDialogAccepted: true } },
        someFutureKey: { nested: 'value' },
        numberOfStartups: 42,
      };
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(original, null, 2));
      registerMcp({ entry: ENTRY, ...CREDS, home });
      const after = readJson(path.join(home, '.claude.json'));
      assert.deepEqual(after.projects, original.projects, 'project history was altered');
      assert.deepEqual(after.someFutureKey, original.someFutureKey, 'an unknown key was dropped');
      assert.equal(after.numberOfStartups, 42);
    });
  });

  it('refuses to overwrite a ~/.claude.json it cannot parse', () => {
    // "Start from {}" here would delete every project the user has, to install a memory
    // tool. Failing loudly is the only acceptable behaviour.
    withHome((home) => {
      const f = path.join(home, '.claude.json');
      fs.writeFileSync(f, '{ this is not json');
      const r = registerMcp({ entry: ENTRY, ...CREDS, home });
      assert.equal(r.verified, false, 'claimed success against an unreadable config');
      assert.ok(r.problems.some((p) => /not valid JSON/.test(p)), r.problems.join('; '));
      assert.equal(fs.readFileSync(f, 'utf8'), '{ this is not json', 'the file was modified');
    });
  });

  it('merges into an existing entry instead of replacing it', () => {
    withHome((home) => {
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
        mcpServers: { ownmind: { command: 'old', disabled: false, env: { KEPT: 'yes' } } },
      }, null, 2));
      registerMcp({ entry: ENTRY, ...CREDS, home });
      const got = readJson(path.join(home, '.claude.json')).mcpServers.ownmind;
      assert.equal(got.command, ENTRY.command, 'the command was not updated');
      assert.equal(got.disabled, false, 'a field the installer does not manage was dropped');
      assert.equal(got.env.KEPT, 'yes', 'a custom env var was dropped');
    });
  });

  it('writes to the home it is given, never to os.homedir()', () => {
    /**
     * Found by this test suite damaging the real machine it ran on.
     *
     * The first version of the installer wiring let the helper default to `os.homedir()`.
     * On Windows that resolves from `USERPROFILE`, while `install.sh` builds every other
     * path from bash's `$HOME`. Overriding `HOME` to a scratch directory and running the
     * block wrote a test API key into the developer's real `~/.claude.json` and
     * `~/.claude/settings.json`, and then reported "verified" — because it had genuinely
     * written and read back, just somewhere nobody was looking.
     *
     * That is the same shape as the defect this release fixes: a correct write to the
     * wrong file, confirmed by a check that never asked which file. So the home directory
     * is now an argument, and this pins it.
     */
    withHome((home) => {
      const realHomeMarker = path.join(os.homedir(), '.claude.json');
      const before = fs.existsSync(realHomeMarker)
        ? fs.readFileSync(realHomeMarker, 'utf8') : null;

      registerMcp({ entry: ENTRY, ...CREDS, home });

      assert.ok(fs.existsSync(path.join(home, '.claude.json')),
        'nothing was written to the home directory it was given');
      const after = fs.existsSync(realHomeMarker)
        ? fs.readFileSync(realHomeMarker, 'utf8') : null;
      assert.equal(after, before,
        'the real ~/.claude.json was touched despite an explicit home argument');
    });
  });

  it('the upgrade path reads a settings.json written by PowerShell (BOM and all)', () => {
    /**
     * PowerShell 5.1's `Set-Content -Encoding utf8` writes UTF-8 **with** a byte-order
     * mark, and `JSON.parse` throws on one. The upgrade path read settings.json with a
     * bare parse, so on any machine whose settings.json had been touched by a PowerShell
     * tool it threw, fell into the catch, reported NOENTRY and left the machine
     * unregistered — silently, and only on Windows.
     *
     * Found by writing the test fixture with PowerShell rather than Node, which is the
     * only reason it surfaced at all.
     */
    const { execFileSync } = require_('node:child_process');
    withHome((home) => {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      const settings = JSON.stringify({
        mcpServers: { ownmind: { ...ENTRY, env: {
          OWNMIND_API_URL: CREDS.apiUrl, OWNMIND_API_KEY: CREDS.apiKey,
        } } },
      }, null, 2);
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), `﻿${settings}`, 'utf8');

      const out = execFileSync(process.execPath, [
        path.join(repoRoot, 'scripts/install-helpers/register-mcp-cli.cjs'), '--upgrade', home,
      ], { encoding: 'utf8' });

      assert.match(out, /VERIFIED/, `a BOM defeated the upgrade path: ${out.trim()}`);
      assert.ok(fs.existsSync(path.join(home, '.claude.json')),
        'reported success but wrote nothing');
    });
  });

  it('mergeEntry is pure — it does not mutate what it is given', () => {
    const original = { mcpServers: { other: { command: 'x' } } };
    const snapshot = JSON.stringify(original);
    mergeEntry(original, ENTRY, CREDS);
    assert.equal(JSON.stringify(original), snapshot, 'mergeEntry mutated its input');
  });
});

describe('v1.26.112 — the installers actually call it', () => {
  // Without this, the helper can be perfect and still never run — which is the shape of
  // the original defect: correct code writing to a file nothing reads.
  for (const script of [
    'install.sh', 'install.ps1',
    // The updaters matter more than the installers. Nobody re-runs an installer: the
    // auto-update path is `git pull` → `npm install` → update.{sh,ps1}, so a fix that
    // lives only in the installers reaches new users and nobody else, while the release
    // notes claim the repair. v1.26.104 shipped exactly that mistake with the git-hook
    // wrappers, which is why these two are pinned.
    'scripts/update.sh', 'scripts/update.ps1',
  ]) {
    it(`${script} registers through the shared helper`, () => {
      const src = fs.readFileSync(path.join(repoRoot, script), 'utf8');
      // The CLI, not the library: `node -e` does not survive PowerShell 5.1 and a JSON
      // argument does not either, so a script that embeds JavaScript is a script that
      // silently does nothing on Windows. Both were measured on 2026-08-09.
      assert.ok(src.includes('register-mcp-cli.cjs'),
        `${script} does not call register-mcp-cli.cjs, so it cannot be writing ~/.claude.json`);
      // And it must not embed the registration as source. A script that calls registerMcp
      // inline is one that hands JavaScript to a shell, which is what silently did nothing
      // on Windows. The CLI path may be assigned to a variable first, so this checks for
      // the give-away call rather than trying to match one line.
      assert.ok(!src.includes('registerMcp({'),
        `${script} still embeds the registration as JavaScript instead of calling the CLI`);
    });
  }

  it('the updaters pass an explicit home to resolveCredentials', () => {
    // Reading credentials from os.homedir() while writing the home the caller supplied is
    // the same two-places-nobody-compares defect in miniature. Caught by review, not by a
    // test, so it gets one.
    for (const script of ['scripts/update.sh', 'scripts/update.ps1']) {
      const src = fs.readFileSync(path.join(repoRoot, script), 'utf8');
      if (!src.includes('resolveCredentials(')) continue;
      assert.ok(src.includes('resolveCredentials({ home })'),
        `${script} calls resolveCredentials() without a home — it would read a different `
        + 'profile than the one it writes');
    }
  });

  it('the self-check asks whether the server is registered, not just present', () => {
    // `mcp_files` and `mcp_node_modules` both passed on a machine where the tools did not
    // exist in any session. Nothing looked at the file that decides whether it is launched.
    const src = fs.readFileSync(path.join(repoRoot, 'scripts/install-helpers/self-check.cjs'), 'utf8');
    assert.ok(src.includes('checkMcpRegistered'), 'self-check has no registration check');
    assert.ok(/checks\.push\(await safeCheck\('mcp_registered'/.test(src),
      'checkMcpRegistered exists but is never added to the run');
  });

  it('the setup doc points at the file Claude Code reads', () => {
    // The doc told users to edit ~/.claude/settings.json, which does nothing for MCP.
    const doc = fs.readFileSync(path.join(repoRoot, 'docs/setup-claude-code.md'), 'utf8');
    assert.ok(doc.includes('.claude.json'),
      'setup-claude-code.md never mentions ~/.claude.json, the file MCP is launched from');
  });
});
