import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';
import { execBashScript } from './helpers/bash-script.js';

/**
 * A machine whose only Node is the private runtime under ~/.ownmind/runtime has no `node` on
 * the PATH Claude Code hands to a hook or an MCP server. The installer therefore writes the
 * runtime's absolute path into every generated command on such a machine — and only there:
 * a machine with a system Node (nvm users included) must keep today's configuration byte for
 * byte. The first block below pins that; the rest cover the new shape.
 */

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const helper = (f) => path.join(root, 'scripts', 'install-helpers', f);

const session = require(helper('session-hook-command.cjs'));
const pre = require(helper('ensure-pretooluse-hooks.cjs'));
const stop = require(helper('add-stop-hook.cjs'));
const post = require(helper('add-post-tool-use-hook.cjs'));
const { ensureSessionHook } = require(helper('ensure-session-hook.cjs'));

const MAC_NODE = '/Users/Jörg Müller/.ownmind/runtime/current/bin/node';
const WIN_NODE = 'C:\\Users\\Jane Doe\\.ownmind\\runtime\\current\\node.exe';
const WIN_NODE_FWD = 'C:/Users/Jane Doe/.ownmind/runtime/current/node.exe';
const IS_WIN = process.platform === 'win32';

/** A file standing in for the private runtime, at <tmp>/<sub>/.ownmind/runtime/current/bin/node. */
function fakeRuntime(sub = '') {
  const home = path.join(tempDir('ownmind-node-rt-'), sub);
  const nodeBin = path.join(home, '.ownmind', 'runtime', 'current', 'bin', 'node');
  fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
  fs.writeFileSync(nodeBin, '');
  // Forward slashes on Windows: the spelling the helpers write (and still a valid path there).
  return { home, nodeBin: IS_WIN ? nodeBin.replace(/\\/g, '/') : nodeBin };
}

const runCli = (script, args) => execFileSync(process.execPath, [helper(script), ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

// ---------------------------------------------------------------------------------------------
// (a) Snapshot: no nodeBin means exactly the strings the code produced before this change.
// ---------------------------------------------------------------------------------------------

// Captured from a run of the code before the private runtime existed. A change here is a change
// to every system-Node machine's settings.json on its next upgrade.
const SNAPSHOT_SETTINGS = {
  hooks: {
    PostToolUse: [
      { matcher: 'mcp__ownmind__.*', hooks: [{ type: 'command', command: 'node "/Users/snap/.ownmind/hooks/ownmind-tty-echo.cjs"' }] },
    ],
    Stop: [
      { hooks: [{ type: 'command', command: 'node "/Users/snap/.ownmind/hooks/ownmind-reply-lint.js"' }] },
    ],
    PreToolUse: [
      { hooks: [{ type: 'command', command: 'node "/Users/snap/.ownmind/hooks/ownmind-iron-rule-check.js"' }], matcher: 'Bash' },
      { hooks: [{ type: 'command', command: 'node "/Users/snap/.ownmind/hooks/ownmind-iron-rule-check.js"' }], matcher: 'Edit|Write|MultiEdit|NotebookEdit' },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: 'node "/Users/snap/.ownmind/hooks/ownmind-prompt-inject.js"' }] },
    ],
    SessionStart: ['startup', 'resume', 'clear', 'compact'].map((matcher) => ({
      matcher,
      hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-session-start.sh', timeout: 10 }],
    })),
  },
};

describe('without nodeBin every generator returns what it returned before', () => {
  it('SessionStart command, both platforms', () => {
    assert.equal(session.sessionStartCommand({ platform: 'darwin', ownmindDir: '/Users/a/.ownmind' }),
      'bash ~/.claude/hooks/ownmind-session-start.sh');
    assert.equal(session.sessionStartCommand({ platform: 'linux' }),
      'bash ~/.claude/hooks/ownmind-session-start.sh');
    assert.equal(session.sessionStartCommand({ platform: 'win32', ownmindDir: 'C:\\Users\\Jane Doe\\.ownmind' }),
      'node "C:/Users/Jane Doe/.ownmind/hooks/ownmind-session-start.js"');
    assert.equal(session.sessionStartCommand({ platform: 'win32', hookDir: 'C:\\Users\\Jane Doe\\.claude\\hooks' }),
      'node "C:/Users/Jane Doe/.ownmind/hooks/ownmind-session-start.js"');
  });

  it('PreToolUse and UserPromptSubmit commands', () => {
    assert.equal(pre.buildPreCmd('/Users/a/.ownmind'), 'node "/Users/a/.ownmind/hooks/ownmind-iron-rule-check.js"');
    assert.equal(pre.buildPreCmd('C:\\Users\\Jane Doe\\.ownmind'), 'node "C:/Users/Jane Doe/.ownmind/hooks/ownmind-iron-rule-check.js"');
    assert.equal(pre.buildInjectCmd('/Users/a/.ownmind'), 'node "/Users/a/.ownmind/hooks/ownmind-prompt-inject.js"');
  });

  it('Stop and PostToolUse entries', { skip: IS_WIN && 'path.join spells these with backslashes on Windows' }, () => {
    assert.deepEqual(stop.buildHookEntry('/Users/a/.ownmind'), {
      hooks: [{ type: 'command', command: 'node "/Users/a/.ownmind/hooks/ownmind-reply-lint.js"' }],
    });
    assert.deepEqual(post.buildHookEntry('/Users/a/.ownmind'), {
      matcher: 'mcp__ownmind__.*',
      hooks: [{ type: 'command', command: 'node "/Users/a/.ownmind/hooks/ownmind-tty-echo.cjs"' }],
    });
  });

  it('the settings.json the four helpers write together, byte for byte', { skip: IS_WIN && 'POSIX paths in the snapshot' }, () => {
    const dir = tempDir('ownmind-node-shape-');
    const settings = path.join(dir, 'settings.json');
    runCli('add-post-tool-use-hook.cjs', [settings, '--ownmind-dir', '/Users/snap/.ownmind']);
    runCli('add-stop-hook.cjs', [settings, '--ownmind-dir', '/Users/snap/.ownmind']);
    runCli('ensure-pretooluse-hooks.cjs', [settings, '--ownmind-dir', '/Users/snap/.ownmind']);
    runCli('ensure-session-hook.cjs', ['--settings', settings, '--ownmind-dir', '/Users/snap/.ownmind', '--platform', 'darwin']);
    assert.equal(fs.readFileSync(settings, 'utf8'), JSON.stringify(SNAPSHOT_SETTINGS, null, 2));
  });

  it('the Windows SessionStart entries ensure-session-hook writes, byte for byte', () => {
    const dir = tempDir('ownmind-node-shape-');
    const settings = path.join(dir, 'settings.json');
    fs.writeFileSync(settings, '{}');
    runCli('ensure-session-hook.cjs', ['--settings', settings, '--ownmind-dir', 'C:/Users/Jane Doe/.ownmind', '--platform', 'win32']);
    const expected = {
      hooks: {
        SessionStart: ['startup', 'resume', 'clear', 'compact'].map((matcher) => ({
          matcher,
          hooks: [{ type: 'command', command: 'node "C:/Users/Jane Doe/.ownmind/hooks/ownmind-session-start.js"', timeout: 10 }],
        })),
      },
    };
    assert.equal(fs.readFileSync(settings, 'utf8'), JSON.stringify(expected, null, 2));
  });

  it('install.sh still registers the MCP server with bare node on a system-Node Mac', () => {
    const sh = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
    assert.match(sh, /MCP_COMMAND='node'/);
    assert.match(sh, /MCP_COMMAND='cmd\.exe'/);
  });
});

// ---------------------------------------------------------------------------------------------
// (b) With nodeBin: quoted, and the settings survive a JSON round trip.
// ---------------------------------------------------------------------------------------------

describe('with nodeBin every command names that Node, quoted', () => {
  it('SessionStart: Windows runs the private node.exe; Mac keeps the bash command', () => {
    assert.equal(
      session.sessionStartCommand({ platform: 'win32', ownmindDir: 'C:\\Users\\Jane Doe\\.ownmind', nodeBin: WIN_NODE }),
      `"${WIN_NODE_FWD}" "C:/Users/Jane Doe/.ownmind/hooks/ownmind-session-start.js"`,
    );
    // The script itself prepends runtime/current/bin to PATH, so the entry needs no change.
    assert.equal(session.sessionStartCommand({ platform: 'darwin', nodeBin: MAC_NODE }),
      'bash ~/.claude/hooks/ownmind-session-start.sh');
  });

  it('PreToolUse, UserPromptSubmit, Stop and PostToolUse', () => {
    const om = '/Users/Jörg Müller/.ownmind';
    assert.equal(pre.buildPreCmd(om, MAC_NODE), `"${MAC_NODE}" "${om}/hooks/ownmind-iron-rule-check.js"`);
    assert.equal(pre.buildPreCmd({ ownmindDir: om, nodeBin: MAC_NODE }), `"${MAC_NODE}" "${om}/hooks/ownmind-iron-rule-check.js"`);
    assert.equal(pre.buildInjectCmd(om, MAC_NODE), `"${MAC_NODE}" "${om}/hooks/ownmind-prompt-inject.js"`);
    assert.match(stop.buildHookEntry(om, MAC_NODE).hooks[0].command, /^"[^"]+\/node" "[^"]+ownmind-reply-lint\.js"$/);
    assert.match(post.buildHookEntry(om, MAC_NODE).hooks[0].command, /^"[^"]+\/node" "[^"]+ownmind-tty-echo\.cjs"$/);
  });

  it('a Windows nodeBin is written with forward slashes; one containing a double quote is refused', () => {
    assert.equal(pre.buildPreCmd('C:/Users/Jane Doe/.ownmind', WIN_NODE),
      `"${WIN_NODE_FWD}" "C:/Users/Jane Doe/.ownmind/hooks/ownmind-iron-rule-check.js"`);
    assert.throws(() => pre.buildPreCmd('/Users/a/.ownmind', '/Users/a"b/.ownmind/runtime/current/bin/node'), /double quote/);
    const dir = tempDir('ownmind-node-shape-');
    assert.throws(() => runCli('ensure-pretooluse-hooks.cjs', [path.join(dir, 's.json'), '--node-bin', '/x"y/node']));
  });

  for (const [label, nodeBin, ownmindDir, platform] of [
    ['macOS', MAC_NODE, '/Users/Jörg Müller/.ownmind', 'darwin'],
    ['Windows', WIN_NODE, 'C:\\Users\\Jane Doe\\.ownmind', 'win32'],
  ]) {
    it(`${label}: the helpers write it through --node-bin and the file round-trips`, () => {
      const dir = tempDir('ownmind-node-shape-');
      const settings = path.join(dir, 'settings.json');
      runCli('add-post-tool-use-hook.cjs', [settings, '--ownmind-dir', ownmindDir, '--node-bin', nodeBin]);
      runCli('add-stop-hook.cjs', [settings, '--ownmind-dir', ownmindDir, '--node-bin', nodeBin]);
      runCli('ensure-pretooluse-hooks.cjs', [settings, '--ownmind-dir', ownmindDir, '--node-bin', nodeBin]);
      runCli('ensure-session-hook.cjs', ['--settings', settings, '--ownmind-dir', ownmindDir, '--platform', platform, '--node-bin', nodeBin]);
      const text = fs.readFileSync(settings, 'utf8');
      const parsed = JSON.parse(text);
      assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);

      const commands = Object.values(parsed.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
      const nodeCommands = commands.filter((c) => !c.startsWith('bash '));
      assert.ok(nodeCommands.length >= 5, `expected the node-run hooks, got ${nodeCommands.length}`);
      const written = nodeBin.replace(/\\/g, '/');
      for (const c of nodeCommands) assert.ok(c.startsWith(`"${written}" "`), c);
      if (platform === 'darwin') {
        assert.ok(commands.includes('bash ~/.claude/hooks/ownmind-session-start.sh'));
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// (c) isGeneratedCommand: both shapes are ours; a user's own command is not.
// ---------------------------------------------------------------------------------------------

describe('isGeneratedCommand accepts both shapes', () => {
  it('claims bare node and a quoted absolute node', () => {
    for (const c of [
      'node "C:/Users/a/.ownmind/hooks/ownmind-session-start.js"',
      `"${MAC_NODE}" "/Users/Jörg Müller/.ownmind/hooks/ownmind-session-start.js"`,
      `"${WIN_NODE}" "C:/Users/Jane Doe/.ownmind/hooks/ownmind-session-start.js"`,
      'bash ~/.claude/hooks/ownmind-session-start.sh',
    ]) {
      assert.equal(session.isGeneratedCommand(c), true, c);
    }
  });

  it('refuses a user\'s own command', () => {
    for (const c of [
      '"/usr/local/bin/python3" "C:/x/ownmind-session-start.js"',
      `"${MAC_NODE}" "C:/x/ownmind-session-start.js" --debug`,
      '"relative/node" "C:/x/ownmind-session-start.js"',
      `"${MAC_NODE}" "C:/x/some-other-hook.js"`,
      'my-wrapper node C:/x/ownmind-session-start.js',
      // An absolute Node that is not OwnMind's runtime is somebody's deliberate choice.
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\x\\.ownmind\\hooks\\ownmind-session-start.js"',
      '"/opt/homebrew/bin/node" "/Users/x/.ownmind/hooks/ownmind-session-start.js"',
    ]) {
      assert.equal(session.isGeneratedCommand(c), false, c);
    }
  });

  it('claims a foreign absolute node only when it is exactly the requested nodeBin', () => {
    const c = '"C:/Tools/node/node.exe" "C:/Users/x/.ownmind/hooks/ownmind-session-start.js"';
    assert.equal(session.isGeneratedCommand(c), false);
    assert.equal(session.isGeneratedCommand(c, { nodeBin: 'C:\\Tools\\node\\node.exe' }), true);
  });
});

// ---------------------------------------------------------------------------------------------
// (d) needsRewrite: never flip a working entry into the other shape.
// ---------------------------------------------------------------------------------------------

describe('needsRewrite keeps whichever shape still works', () => {
  const ownmindDir = 'C:/Users/Jane Doe/.ownmind';
  const base = { platform: 'win32', ownmindDir };

  it('leaves an absolute-form entry when nodeBin matches', () => {
    const opts = { ...base, nodeBin: WIN_NODE };
    assert.equal(session.needsRewrite(session.sessionStartEntries(opts), opts), false);
  });

  it('leaves a bare entry when nodeBin is unset', () => {
    assert.equal(session.needsRewrite(session.sessionStartEntries(base), base), false);
  });

  it('rewrites a bare entry on a machine whose only Node is the private one', () => {
    assert.equal(session.needsRewrite(session.sessionStartEntries(base), { ...base, nodeBin: WIN_NODE }), true);
  });

  it('leaves a private-runtime entry whose node still exists when nodeBin is unset', () => {
    const { nodeBin } = fakeRuntime();
    const entries = session.sessionStartEntries({ ...base, nodeBin });
    assert.equal(session.needsRewrite(entries, base), false);
    const r = ensureSessionHook(JSON.parse(JSON.stringify({ hooks: { SessionStart: entries } })), base);
    assert.equal(r.status, 'unchanged');
  });

  it('rewrites a private-runtime entry whose node no longer exists', () => {
    const gone = path.join(tempDir('ownmind-node-gone-'), '.ownmind', 'runtime', 'current', 'bin', 'node');
    const entries = session.sessionStartEntries({ ...base, nodeBin: gone });
    assert.equal(session.needsRewrite(entries, base), true);
    const r = ensureSessionHook({ hooks: { SessionStart: entries } }, base);
    assert.equal(r.status, 'repaired');
    assert.equal(r.settings.hooks.SessionStart[0].hooks[0].command, session.sessionStartCommand(base));
  });

  it('leaves a hand-written foreign absolute node alone (user_customised)', () => {
    // A working entry seen in the wild: the system Node by absolute path, the target spelled
    // with backslashes, so it is not identical to anything we would write.
    const foreign = ['startup', 'resume', 'clear', 'compact'].map((matcher) => ({
      matcher,
      hooks: [{ type: 'command', command: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Jane Doe\\.ownmind\\hooks\\ownmind-session-start.js"', timeout: 10 }],
    }));
    assert.equal(session.needsRewrite(foreign, base), false);
    const r = ensureSessionHook(JSON.parse(JSON.stringify({ hooks: { SessionStart: foreign } })), base);
    assert.equal(r.status, 'user_customised');
    assert.equal(r.changed, false);
  });

  it('a repair without nodeBin keeps the private runtime an existing entry runs', () => {
    // An updater passes no nodeBin. Only `startup` is present, so the entries must be rebuilt —
    // and the rebuilt four must keep the runtime, because this machine has no other Node.
    const { nodeBin } = fakeRuntime();
    const one = [{
      matcher: 'startup',
      hooks: [{ type: 'command', command: `"${nodeBin}" "C:/Users/Jane Doe/.ownmind/hooks/ownmind-session-start.js"`, timeout: 10 }],
    }];
    assert.equal(session.needsRewrite(one, base), true);
    const r = ensureSessionHook({ hooks: { SessionStart: one } }, base);
    assert.equal(r.status, 'repaired');
    const want = `"${nodeBin}" "C:/Users/Jane Doe/.ownmind/hooks/ownmind-session-start.js"`;
    assert.deepEqual(r.settings.hooks.SessionStart.map((e) => e.matcher), ['startup', 'resume', 'clear', 'compact']);
    for (const e of r.settings.hooks.SessionStart) assert.equal(e.hooks[0].command, want);
  });

  it('ensure-pretooluse-hooks follows the same rule', () => {
    const dir = tempDir('ownmind-node-shape-');
    const settingsPath = path.join(dir, 'settings.json');
    const om = '/Users/x/.ownmind';
    const { nodeBin: runtime } = fakeRuntime();

    // Written with a runtime that exists, then re-run without nodeBin: left alone.
    assert.equal(pre.ensureHooks(settingsPath, om, { nodeBin: runtime }).status, 'ok');
    let r = pre.ensureHooks(settingsPath, om);
    assert.ok(r.results.every((x) => x.action === 'unchanged'), JSON.stringify(r.results));

    // Re-run with the same nodeBin: unchanged.
    r = pre.ensureHooks(settingsPath, om, { nodeBin: runtime });
    assert.ok(r.results.every((x) => x.action === 'unchanged'), JSON.stringify(r.results));

    // One matcher removed, re-run without nodeBin: the re-added entry keeps the runtime.
    let s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    s.hooks.PreToolUse = s.hooks.PreToolUse.filter((g) => g.matcher === 'Bash');
    fs.writeFileSync(settingsPath, JSON.stringify(s));
    r = pre.ensureHooks(settingsPath, om);
    s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const c of s.hooks.PreToolUse.map((g) => g.hooks[0].command)) assert.equal(c, pre.buildPreCmd(om, runtime));

    // Written with a runtime that is gone, then re-run without nodeBin: back to bare node.
    const gone = path.join(dir, '.ownmind', 'runtime', 'current', 'bin', 'node');
    fs.rmSync(settingsPath);
    pre.ensureHooks(settingsPath, om, { nodeBin: gone });
    r = pre.ensureHooks(settingsPath, om);
    assert.ok(r.results.every((x) => x.action === 'repaired'), JSON.stringify(r.results));
    s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(s.hooks.PreToolUse[0].hooks[0].command, pre.buildPreCmd(om));

    // A bare entry on a machine that now passes nodeBin: rewritten to the absolute form.
    r = pre.ensureHooks(settingsPath, om, { nodeBin: runtime });
    assert.ok(r.results.every((x) => x.action === 'repaired'), JSON.stringify(r.results));
  });
});

// ---------------------------------------------------------------------------------------------
// (e) The MCP entry's absolute node is read back and executed by install-artifacts.cjs.
// ---------------------------------------------------------------------------------------------

describe('install-artifacts runs the node the MCP entry names', { skip: IS_WIN && 'fake node is a shell script' }, () => {
  const { checkInstallArtifacts } = require(helper('install-artifacts.cjs'));

  function setup(script, sub = '') {
    const home = path.join(tempDir('ownmind-node-mcp-'), sub);
    const nodeBin = path.join(home, '.ownmind', 'runtime', 'current', 'bin', 'node');
    fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
    fs.writeFileSync(nodeBin, script);
    fs.chmodSync(nodeBin, 0o755);
    const out = execFileSync(process.execPath, [
      helper('register-mcp-cli.cjs'),
      '--command', nodeBin,
      '--arg', path.join(home, '.ownmind', 'mcp', 'index.js'),
      '--url', 'https://example.invalid',
      '--key', 'test-key-0123456789',
      '--home', home,
    ], { encoding: 'utf8' });
    assert.match(out, /^VERIFIED$/m);
    return { home, nodeBin, marker: path.join(home, 'ran') };
  }

  it('passes when that node answers --version, and it really ran', () => {
    const home0 = tempDir('ownmind-node-mcp-marker-');
    const marker = path.join(home0, 'ran');
    const { home } = setup(`#!/bin/sh\necho "$@" > "${marker}"\necho v22.11.0\n`);
    const r = checkInstallArtifacts({ home });
    assert.ok(!r.missing.some((m) => m.id === 'configured_node'), JSON.stringify(r.missing));
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), '--version');
  });

  it('round-trips through a home directory whose path contains a space', () => {
    const home0 = tempDir('ownmind-node-mcp-marker-');
    const marker = path.join(home0, 'ran');
    const { home, nodeBin } = setup(`#!/bin/sh\necho "$@" > "${marker}"\necho v22.11.0\n`, 'Jane Doe');
    const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(claude.mcpServers.ownmind.command, nodeBin);
    const r = checkInstallArtifacts({ home });
    assert.ok(!r.missing.some((m) => m.id === 'configured_node'), JSON.stringify(r.missing));
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), '--version');
  });

  it('ignores absolute-node hooks that are not OwnMind\'s runtime', () => {
    // A developer running a checkout's hooks with their own Node is not a private-runtime machine.
    const home = tempDir('ownmind-node-dev-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '"/missing/bin/node" "/Users/dev/SourceCode/OwnMind/hooks/ownmind-reply-lint.js"' }] }] },
    }));
    const { configuredNodes } = require(helper('install-artifacts.cjs'));
    assert.deepEqual(configuredNodes({ home }), []);
    assert.ok(!checkInstallArtifacts({ home }).missing.some((m) => m.id === 'configured_node'));
  });

  it('reports it missing when that node cannot start', () => {
    const { home, nodeBin } = setup('#!/bin/sh\nexit 3\n');
    const r = checkInstallArtifacts({ home });
    const m = r.missing.find((x) => x.id === 'configured_node');
    assert.ok(m, JSON.stringify(r.missing));
    assert.equal(m.path, nodeBin);
  });

  it('does not apply to a bare-node machine', () => {
    const home = tempDir('ownmind-node-mcp-bare-');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { ownmind: { command: 'node', args: ['x'] } } }));
    const r = checkInstallArtifacts({ home });
    assert.ok(!r.missing.some((m) => m.id === 'configured_node'));
  });
});

// ---------------------------------------------------------------------------------------------
// (f) Every entry script puts the private runtime on PATH before its first node call.
// ---------------------------------------------------------------------------------------------

const BASH_LINE = 'if [ -d "$OWNMIND_DIR/runtime/current/bin" ]; then PATH="$OWNMIND_DIR/runtime/current/bin:$PATH"; export PATH; fi';
const PS_LINE = 'if (Test-Path "$OwnmindDir\\runtime\\current\\node.exe") { $env:Path = "$OwnmindDir\\runtime\\current;$env:Path" }';
// The git hooks run under Git's sh on Windows too, where the runtime has node.exe at its top.
const GIT_HOOK_LINES = [
  'if [ -d "$HOME/.ownmind/runtime/current/bin" ]; then PATH="$HOME/.ownmind/runtime/current/bin:$PATH"; export PATH;',
  'elif [ -f "$HOME/.ownmind/runtime/current/node.exe" ]; then PATH="$HOME/.ownmind/runtime/current:$PATH"; export PATH; fi',
];

const NODE_CALL = /(^|[\s;&|(`])node(\.exe)?(\s|$)/;

function lineIndex(lines, needle) {
  return lines.findIndex((l) => l.trim() === needle);
}

function firstNodeCall(lines, after = -1) {
  return lines.findIndex((l, i) => i !== after && !/^\s*#/.test(l) && NODE_CALL.test(l)
    && !l.includes('runtime/current') && !l.includes('runtime\\current'));
}

describe('entry scripts reach the private runtime before their first node call', () => {
  for (const [file, line] of [
    ['hooks/ownmind-session-start.sh', BASH_LINE],
    ['scripts/install-helpers/run-scanner.sh', BASH_LINE],
    ['scripts/check-sync.sh', BASH_LINE],
    ['scripts/interactive-upgrade.sh', BASH_LINE],
    ['scripts/update.sh', BASH_LINE],
    ['scripts/check-sync.ps1', PS_LINE],
    ['scripts/interactive-upgrade.ps1', PS_LINE],
    ['scripts/update.ps1', PS_LINE],
    ['scripts/windows/register-scanner-task.ps1', PS_LINE],
  ]) {
    it(file, () => {
      const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
      const at = lineIndex(lines, line);
      assert.ok(at >= 0, `${file} is missing: ${line}`);
      const first = firstNodeCall(lines);
      assert.ok(first > at, `${file}: first node call at line ${first + 1} comes before the PATH line at ${at + 1}`);
    });
  }

  for (const file of [
    'hooks/ownmind-git-pre-commit', 'hooks/ownmind-git-post-commit',
    'hooks/ownmind-git-pre-merge-commit', 'hooks/ownmind-git-commit-msg',
  ]) {
    it(file, () => {
      const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
      const at = lineIndex(lines, GIT_HOOK_LINES[0]);
      assert.ok(at >= 0 && lines[at + 1].trim() === GIT_HOOK_LINES[1], `${file} is missing the PATH lines`);
      assert.ok(firstNodeCall(lines) > at + 1, file);
    });
  }

  it('both upgraders set PATH before the preflight and before update-to-release.mjs', () => {
    for (const [file, line, preflight] of [
      ['scripts/interactive-upgrade.sh', BASH_LINE, /preflight\.sh/],
      ['scripts/interactive-upgrade.ps1', PS_LINE, /preflight\.ps1/],
    ]) {
      const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
      const at = lineIndex(lines, line);
      const pf = lines.findIndex((l) => !/^\s*#/.test(l) && preflight.test(l));
      const upd = lines.findIndex((l) => !/^\s*#/.test(l) && /node\s+scripts[/\\]install-helpers[/\\]update-to-release\.mjs/.test(l));
      assert.ok(at >= 0 && pf > at && upd > at, `${file}: PATH ${at + 1}, preflight ${pf + 1}, update-to-release ${upd + 1}`);
    }
  });

  it('the bash line actually prepends the runtime', { skip: IS_WIN }, () => {
    const dir = tempDir('ownmind-node-path-');
    fs.mkdirSync(path.join(dir, 'runtime', 'current', 'bin'), { recursive: true });
    const out = execBashScript(`set -u\nPATH=/usr/bin:/bin\n${BASH_LINE}\nprintf '%s' "$PATH"\n`, {
      encoding: 'utf8', env: { ...process.env, OWNMIND_DIR: dir },
    });
    assert.equal(out, `${dir}/runtime/current/bin:/usr/bin:/bin`);
  });
});

// ---------------------------------------------------------------------------------------------
// Callers: the installers pass the private Node only when OWNMIND_PRIVATE_NODE=1.
// ---------------------------------------------------------------------------------------------

describe('the installers hand the private Node to the helpers only when it is the only one', () => {
  const sh = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const ps = fs.readFileSync(path.join(root, 'install.ps1'), 'utf8');
  const EXPAND = '${NODE_BIN_ARGS[@]+"${NODE_BIN_ARGS[@]}"}';

  it('install.sh: §2.1, §2.2, §4c-1 and §4c-2 all pass NODE_BIN_ARGS', () => {
    for (const v of ['ADD_HOOK_HELPER', 'ADD_STOP_HOOK_HELPER', 'ENSURE_PRE_HOOK', 'ENSURE_HOOK']) {
      const call = sh.split('\n').find((l) => l.includes(`node "$${v}"`));
      assert.ok(call && call.includes(EXPAND), `${v}: ${call}`);
    }
  });

  it('install.sh: the gate yields --node-bin only with OWNMIND_PRIVATE_NODE=1, under set -u', { skip: IS_WIN }, () => {
    const block = sh.match(/\nNODE_BIN_ARGS=\(\)\n[\s\S]*?\nfi\n/);
    assert.ok(block, 'NODE_BIN_ARGS block not found');
    const mcp = sh.match(/\n  MCP_COMMAND='node'\n[\s\S]*?\n  fi\n/);
    assert.ok(mcp, 'MCP_COMMAND gate not found');
    const script = `set -u\n${block[0]}\n${mcp[0]}\nprintf '%s|' ${EXPAND} "$MCP_COMMAND"\n`;
    const run = (env) => execBashScript(script, { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    assert.equal(run({}), 'node|');
    assert.equal(run({ OWNMIND_NODE: MAC_NODE }), 'node|');
    assert.equal(run({ OWNMIND_PRIVATE_NODE: '1', OWNMIND_NODE: MAC_NODE }), `--node-bin|${MAC_NODE}|${MAC_NODE}|`);
  });

  it('install.ps1: 2.1, 2.2 and 4c pass @NodeBinArgs, built from OWNMIND_PRIVATE_NODE', () => {
    assert.match(ps, /if \(\$env:OWNMIND_PRIVATE_NODE -eq '1' -and \$env:OWNMIND_NODE\) \{ \$NodeBinArgs = @\('--node-bin', \$env:OWNMIND_NODE\) \}/);
    for (const v of ['AddHookHelper', 'AddStopHookHelper', 'PreHookHelper', 'EnsureHook']) {
      const call = ps.split(/\r?\n/).find((l) => new RegExp(`& node \\$${v}\\b`).test(l));
      assert.ok(call && call.includes('@NodeBinArgs'), `${v}: ${call}`);
    }
    // Windows keeps launching the MCP server through start.cmd, which finds the runtime itself.
    assert.match(ps, /command = "cmd\.exe"/);
  });
});

describe('self-check reports the Node the configuration names', () => {
  const { collectMemoryLoadEvidence } = require(helper('self-check.cjs'));

  it('takes the SessionStart command\'s absolute node over whatever PATH finds', () => {
    const home = tempDir('ownmind-node-selfcheck-');
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const entries = session.sessionStartEntries({ platform: 'win32', ownmindDir: 'C:/Users/a/.ownmind', nodeBin: WIN_NODE });
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: entries } }));
    const ev = collectMemoryLoadEvidence({ settingsPath, resolveBinary: (b) => `/usr/bin/${b}` });
    assert.equal(ev.node_path, WIN_NODE_FWD);
  });

  it('falls back to the MCP entry, then to PATH', () => {
    const home = tempDir('ownmind-node-selfcheck-');
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: session.sessionStartEntries({ platform: 'darwin' }) } }));
    const resolveBinary = (b) => `/usr/bin/${b}`;
    assert.equal(collectMemoryLoadEvidence({ settingsPath, resolveBinary }).node_path, '/usr/bin/node');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { ownmind: { command: '/opt/rt/bin/node', args: [] } } }));
    assert.equal(collectMemoryLoadEvidence({ settingsPath, resolveBinary }).node_path, '/opt/rt/bin/node');
  });
});
