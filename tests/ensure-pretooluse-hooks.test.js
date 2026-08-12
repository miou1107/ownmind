import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';

const require = createRequire(import.meta.url);
const helper = require('../scripts/install-helpers/ensure-pretooluse-hooks.cjs');

const OWNMIND_DIR = '/Users/test/.ownmind';
const NODE_CMD = 'node "/Users/test/.ownmind/hooks/ownmind-iron-rule-check.js"';
const BASH_CMD = 'bash ~/.claude/hooks/ownmind-iron-rule-check.sh';
// What every install written before v1.26.92 still carries. It cannot start: the copy under
// ~/.claude/hooks imports ../shared/helpers.js and ~/.claude/shared/ does not exist.
const STALE_CMD = 'node "/Users/test/.claude/hooks/ownmind-iron-rule-check.js"';

let tmpDir;
let settingsPath;

function setup() {
  tmpDir = tempDir('ownmind-pretooluse-');
  settingsPath = path.join(tmpDir, 'settings.json');
}
function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
function write(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
function read() {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}
function commandFor(settings, matcher) {
  const entry = settings.hooks.PreToolUse.find((h) => h.matcher === matcher);
  return entry && entry.hooks[0].command;
}

describe('v1.26.105 — ensure-pretooluse-hooks repairs a stale command, not just a missing one', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('settings.json missing → both matchers created', () => {
    const r = helper.ensureHooks(settingsPath, OWNMIND_DIR, false);
    assert.equal(r.status, 'ok');
    const s = read();
    assert.equal(s.hooks.PreToolUse.length, 2);
    assert.equal(commandFor(s, 'Bash'), NODE_CMD);
    assert.equal(commandFor(s, 'Edit|Write|MultiEdit|NotebookEdit'), NODE_CMD);
  });

  it('the regression: a Bash entry pointing at ~/.claude/hooks is rewritten to the checkout', () => {
    // This is the state measured on an upgraded Windows machine on 2026-08-09: the Bash entry
    // predates v1.26.92 and still names the copy that cannot start, while the Edit entry was
    // written fresh by v1.26.92 and is correct. One settings.json, one dead hook, no output.
    write({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: STALE_CMD }] },
          { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: NODE_CMD }] },
        ],
      },
    });

    const r = helper.ensureHooks(settingsPath, OWNMIND_DIR, false);
    assert.equal(r.status, 'ok');

    const s = read();
    assert.equal(commandFor(s, 'Bash'), NODE_CMD, 'the stale Bash command must be rewritten');
    assert.equal(s.hooks.PreToolUse.length, 2, 'repair must not append a duplicate entry');

    const bash = r.results.find((x) => x.matcher === 'Bash');
    assert.equal(bash.action, 'repaired');
    assert.equal(bash.from, STALE_CMD);
    const edit = r.results.find((x) => x.matcher === 'Edit|Write|MultiEdit|NotebookEdit');
    assert.equal(edit.action, 'unchanged');
  });

  it('an already-correct settings.json is left byte-identical', () => {
    write({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: NODE_CMD }] },
          { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: NODE_CMD }] },
        ],
      },
    });
    const before = fs.readFileSync(settingsPath, 'utf8');

    const r = helper.ensureHooks(settingsPath, OWNMIND_DIR, false);
    assert.equal(r.status, 'ok');
    assert.ok(r.results.every((x) => x.action === 'unchanged'));
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), before, 'a no-op run must not rewrite the file');
    assert.equal(fs.readdirSync(tmpDir).filter((f) => f.includes('.bak.')).length, 0, 'a no-op run must not leave a backup');
  });

  it('bash mode repairs a node command back to the bash hook', () => {
    write({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: NODE_CMD }] }],
      },
    });
    helper.ensureHooks(settingsPath, OWNMIND_DIR, true);
    const s = read();
    assert.equal(commandFor(s, 'Bash'), BASH_CMD);
    assert.equal(commandFor(s, 'Edit|Write|MultiEdit|NotebookEdit'), BASH_CMD, 'the missing matcher is still added');
  });

  it('unrelated user hooks and settings survive', () => {
    write({
      theme: 'dark',
      mcpServers: { ownmind: { command: 'node', args: ['x'] } },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: STALE_CMD }] },
        ],
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo post' }] }],
      },
    });

    helper.ensureHooks(settingsPath, OWNMIND_DIR, false);
    const s = read();
    assert.equal(s.theme, 'dark');
    assert.equal(s.mcpServers.ownmind.command, 'node');
    assert.equal(s.hooks.PostToolUse[0].hooks[0].command, 'echo post');
    // The user's own Bash hook shares the matcher but not the identifier; only the OwnMind
    // entry is touched, and the user's stays where it was.
    assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
    assert.equal(s.hooks.PreToolUse[1].hooks[0].command, NODE_CMD);
  });

  it('a changing run backs the file up first', () => {
    write({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: STALE_CMD }] }] } });
    helper.ensureHooks(settingsPath, OWNMIND_DIR, false);
    const backups = fs.readdirSync(tmpDir).filter((f) => f.includes('.bak.'));
    assert.equal(backups.length, 1);
    assert.match(fs.readFileSync(path.join(tmpDir, backups[0]), 'utf8'), /\.claude\/hooks/);
  });

  it('a settings.json carrying a UTF-8 BOM is still repaired', () => {
    // PowerShell's default `Out-File -Encoding utf8` writes one, which is why this repo has a
    // Write-Utf8NoBom helper. JSON.parse rejects the BOM outright, so without this the repair
    // would fail on exactly the platform the bug lives on.
    const withBom = '﻿' + JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: STALE_CMD }] }] },
    });
    fs.writeFileSync(settingsPath, withBom);

    const r = helper.ensureHooks(settingsPath, OWNMIND_DIR, false);
    assert.equal(r.status, 'ok', r.message);
    assert.equal(commandFor(read(), 'Bash'), NODE_CMD);
  });

  it('malformed settings.json is reported, not overwritten', () => {
    fs.writeFileSync(settingsPath, '{ not json');
    const r = helper.ensureHooks(settingsPath, OWNMIND_DIR, false);
    assert.equal(r.status, 'error');
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{ not json');
  });

  it('buildPreCmd never points at ~/.claude/hooks in node mode', () => {
    // The path that could not start. Asserted directly so a future edit to buildPreCmd has to
    // argue with this line rather than quietly reintroduce it.
    const cmd = helper.buildPreCmd('/home/someone/.ownmind', false);
    assert.ok(!cmd.includes('.claude/hooks'), cmd);
    assert.match(cmd, /\.ownmind\/hooks\/ownmind-iron-rule-check\.js/);
  });
});

describe('v1.26.105 — install-artifacts checks the registered command, not just a copy on disk', () => {
  const artifacts = require('../scripts/install-helpers/install-artifacts.cjs');

  let home;
  let ownmindDir;

  function makeHome(command) {
    home = tempDir('ownmind-artifacts-');
    ownmindDir = path.join(home, '.ownmind');
    // A copy under ~/.claude/hooks — this is what the old check looked at, and it was there
    // the whole time the hook was dead.
    fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'hooks', 'ownmind-iron-rule-check.js'), '// copy');
    if (command !== null) {
      fs.writeFileSync(
        path.join(home, '.claude', 'settings.json'),
        JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } })
      );
    }
  }
  function missingIds() {
    return artifacts.checkInstallArtifacts({ home, ownmindDir }).missing.map((m) => m.id);
  }

  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('a copy on disk no longer covers for a command that names a different file', () => {
    // The shape measured on 2026-08-09: a real copy sits in ~/.claude/hooks, which is all the
    // old check looked at, while the registered command names a path with no such file.
    makeHome(null);
    const gone = path.join(home, '.gone', 'ownmind-iron-rule-check.js').replace(/\\/g, '/');
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${gone}"` }] }] },
      })
    );
    assert.ok(missingIds().includes('iron_rule_hook'), 'the registered path is the one that has to exist');
  });

  it('the measured machine: the registered file is there, and still cannot start', () => {
    // 2026-08-09, exactly. The two copies are byte-identical, so "does the registered file
    // exist" answers yes — and the hook still died on every Bash call, because the copy under
    // ~/.claude/hooks resolves `../shared/helpers.js` to ~/.claude/shared/, a directory no
    // installer creates. Existing is not starting.
    makeHome(null);
    const registered = path.join(home, '.claude', 'hooks', 'ownmind-iron-rule-check.js');
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${registered.replace(/\\/g, '/')}"` }] },
          ],
        },
      })
    );
    const ids = missingIds();
    assert.ok(!ids.includes('iron_rule_hook'), 'the file itself is present — that was never the question');
    assert.ok(
      ids.includes('iron_rule_hook_deps'),
      'the import the registered hook makes on its first line has to resolve, or it never runs'
    );
  });

  it('a command naming the file that is actually there passes', () => {
    makeHome(null);
    const target = path.join(ownmindDir, 'hooks', 'ownmind-iron-rule-check.js');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '// real');
    fs.mkdirSync(path.join(ownmindDir, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(ownmindDir, 'shared', 'helpers.js'), '// real');
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${target.replace(/\\/g, '/')}"` }] }],
        },
      })
    );
    assert.ok(!missingIds().includes('iron_rule_hook'));
  });

  it('a ~-relative bash command is resolved against home, and keeps the interpreter out of the path', () => {
    makeHome('bash ~/.claude/hooks/ownmind-iron-rule-check.sh');
    assert.ok(missingIds().includes('iron_rule_hook'), 'the .sh is not there, only the .js');

    fs.writeFileSync(path.join(home, '.claude', 'hooks', 'ownmind-iron-rule-check.sh'), '# real');
    assert.ok(!missingIds().includes('iron_rule_hook'));
  });

  it('nothing registered → falls back to looking for a copy, as before', () => {
    makeHome(null);
    assert.ok(!missingIds().includes('iron_rule_hook'), 'the .js copy under ~/.claude/hooks still satisfies it');
  });
});

describe('v1.26.105 — the installers delegate instead of keeping their own copy', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

  // One pattern per language. `PreToolUse.push(` is what the node blocks inside the shell
  // scripts used; PowerShell's inline copy never contained it, it used `PreToolUse +=`. A
  // single JS-shaped pattern therefore passed install.ps1 unchanged — vacuously, in the one
  // file this change exists because CI cannot reach.
  const INLINE_PATTERNS = {
    'install.ps1': /PreToolUse\s*\+=/,
    'install.sh': /PreToolUse\.push\(/,
    'scripts/update.ps1': /PreToolUse\s*\+=/,
    'scripts/update.sh': /PreToolUse\.push\(/,
  };

  for (const script of Object.keys(INLINE_PATTERNS)) {
    it(`${script} calls ensure-pretooluse-hooks.cjs and holds no inline copy`, () => {
      const content = fs.readFileSync(path.join(repoRoot, script), 'utf8');
      assert.ok(
        content.includes('ensure-pretooluse-hooks.cjs'),
        `${script} must delegate PreToolUse registration to the shared helper`
      );
      // The inline copies were the bug: four of them, only one reachable from CI.
      assert.ok(
        !INLINE_PATTERNS[script].test(content),
        `${script} still registers a PreToolUse entry inline — that copy will drift again`
      );
    });
  }

  // The self-check reports install_complete, which now includes the registered hook's
  // dependency. Run before the repair, it reports a machine as broken and the same script
  // then fixes it — one alert per affected machine, about a state that no longer exists by
  // the time anybody reads it. install.sh has always run its artifact check at the tail for
  // this reason; the updaters ran theirs in section 2d, ahead of every repair in section 3.
  for (const [script, selfCheck, repair] of [
    ['scripts/update.sh', 'self-check.cjs', 'ensure-pretooluse-hooks.cjs'],
    ['scripts/update.ps1', 'self-check.cjs', 'ensure-pretooluse-hooks.cjs'],
  ]) {
    it(`${script} reports health after its repairs, not before`, () => {
      const content = fs.readFileSync(path.join(repoRoot, script), 'utf8');
      const invoked = content.lastIndexOf(selfCheck);
      const repaired = content.lastIndexOf(repair);
      assert.ok(invoked > 0 && repaired > 0, `${script} must contain both steps`);
      assert.ok(
        invoked > repaired,
        `${script} runs the self-check before the PreToolUse repair, so it uploads a failure ` +
          `the same run is about to fix`
      );
    });
  }

  // The shell scripts run under `set -e`. A bare `VAR=$(cmd)` carries cmd's exit status, so
  // one non-zero exit from the helper — an unreadable settings.json, a locked file on
  // Windows — takes the whole installer down at that line, and with `2>&1` captured into a
  // variable that is never echoed on the failure path, it takes it down silently. install.sh
  // already carries that lesson in a comment: "`set -e` plus a discarded stderr is how a
  // fatal error produced no output at all for four months."
  for (const script of ['install.sh', 'scripts/update.sh']) {
    it(`${script} does not let a helper failure abort the run under set -e`, () => {
      const content = fs.readFileSync(path.join(repoRoot, script), 'utf8');
      // The invocation names the helper through a variable, so find that variable first
      // rather than grepping for the filename and matching nothing.
      const holder = content.match(
        /^\s*([A-Za-z_][A-Za-z0-9_]*)="[^"]*ensure-pretooluse-hooks\.cjs"/m
      );
      assert.ok(holder, `${script} no longer assigns the helper path to a variable`);
      const bare = content
        .split('\n')
        .filter((line) => line.includes(`$${holder[1]}`))
        .filter((line) => /^\s*[A-Za-z_][A-Za-z0-9_]*=\$\(/.test(line));
      assert.deepEqual(
        bare,
        [],
        `${script} invokes the helper as a bare command substitution; wrap it in ` +
          `\`if var=$(...); then\` so a non-zero exit is reported rather than fatal`
      );
    });
  }
});
