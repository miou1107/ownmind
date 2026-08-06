// v1.26.80 — the SessionStart hook has never once fired on Windows.
//
// Measured on production 2026-08-06, `activity_logs` where `event='init'`, 90 days:
//
//   Vincent.local                     darwin   11275 hook loads
//   cengmingxuandeMacBook-Pro.local   darwin     675
//   phoebelin.local                   darwin     271
//   after            (Adam)           win32        0
//   LAPTOP-G95HIQ3V  (Eric)           win32        0
//   LAPTOP-MBGGLV2J  (采瑤)            win32        0
//   LAPTOP-RGE2HCSQ  (Amiee)          win32        0
//   Fontrip-Joanna                    win32        0
//   TANK / DESKTOP-8DD75VJ            win32        0
//
// Three Macs, twelve thousand loads. Six Windows machines, zero, over three months.
// The hook is what auto-loads a person's memories and iron rules, so on Windows that
// feature has never worked. It fails silently — nothing anywhere said so.
//
// Two defects, both provable from the source without a Windows machine:
//
// 1. `install.ps1` picks the right command (`node …ownmind-session-start.js` when bash is
//    absent) and then the first auto-update throws it away. `update.ps1` recognises any
//    entry containing "ownmind-session-start" — the Node one included — sees it lacks the
//    four matchers install.ps1 never adds, deletes it, and writes four entries hardcoded
//    to `bash ~/.claude/hooks/ownmind-session-start.sh`. Install is correct exactly until
//    the first update, which every machine runs daily.
//
// 2. `install.ps1` decides with `Get-Command bash`. On Windows 10/11 that resolves
//    `System32\bash.exe`, the WSL launcher, so `~` is WSL's home and the hook file is not
//    there. This repo already knows: `scripts/windows/lib/find-git-bash.ps1` exists and
//    `interactive-upgrade.ps1` uses it, commented "避開 WSL relay". That fix was applied to
//    the upgrade verify step and never to the hook that needs it.
//
// The command choice now lives in one testable place instead of three hardcoded strings.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const require_ = createRequire(import.meta.url);

const HELPER = 'scripts/install-helpers/session-hook-command.cjs';
const MATCHERS = ['startup', 'resume', 'clear', 'compact'];

describe('session-hook-command.cjs — one place decides how the hook is invoked', () => {
  const { sessionStartCommand, sessionStartEntries } = require_(path.join(repoRoot, HELPER));

  it('points at the copy under ~/.ownmind, the only one whose imports resolve', () => {
    // Found on Adam's machine, 2026-08-06, after everything else was correct: four
    // matchers, Node, the file present — and still zero loads. The hook imports
    // `../shared/helpers.js`. From ~/.claude/hooks/ that resolves to ~/.claude/shared/,
    // which does not exist, and the process dies with ERR_MODULE_NOT_FOUND before it can
    // report anything. 采瑤's machine worked only because her AI had happened to write a
    // path under ~/.ownmind/hooks/, where the imports do resolve.
    const cmd = sessionStartCommand({ platform: 'win32', ownmindDir: 'C:/Users/Adam/.ownmind' });
    assert.match(cmd, /\.ownmind\/hooks\/ownmind-session-start\.js/);
    assert.doesNotMatch(cmd, /\.claude[\\/]hooks/,
      'the copy under ~/.claude/hooks cannot resolve its own imports');
  });

  it('Windows runs Node directly, never bash', () => {
    const cmd = sessionStartCommand({ platform: 'win32', hookDir: 'C:\\Users\\adam\\.claude\\hooks' });
    assert.match(cmd, /^node /, 'Windows must invoke node, not a shell');
    assert.doesNotMatch(cmd, /\bbash\b/, 'bash on Windows resolves to the WSL launcher');
    assert.doesNotMatch(cmd, /~/, '~ is not expanded the same way, and under WSL points elsewhere');
    assert.match(cmd, /ownmind-session-start\.js/, 'must point at the Node hook, not the .sh');
  });

  it('Windows quotes the path, because home directories contain spaces', () => {
    const cmd = sessionStartCommand({ platform: 'win32', hookDir: 'C:\\Users\\Vin Kao\\.claude\\hooks' });
    assert.match(cmd, /"[^"]*Vin Kao[^"]*"/, 'an unquoted path with a space splits into two arguments');
  });

  it('Windows uses forward slashes, so the JSON string needs no escaping', () => {
    const cmd = sessionStartCommand({ platform: 'win32', hookDir: 'C:\\Users\\adam\\.claude\\hooks' });
    assert.doesNotMatch(cmd, /\\/, 'backslashes in settings.json invite double-escaping bugs');
  });

  it('macOS and Linux keep the bash hook they have been running for months', () => {
    for (const platform of ['darwin', 'linux']) {
      const cmd = sessionStartCommand({ platform });
      assert.equal(cmd, 'bash ~/.claude/hooks/ownmind-session-start.sh',
        `${platform} must not change; 12,000 working hook loads run through this exact string`);
    }
  });

  it('does not ask whether bash exists', () => {
    // The question install.ps1 asked. Having a `bash` on PATH says nothing about whether
    // that bash can see the Windows home directory, and on Windows it usually cannot.
    //
    // Comments are stripped first: this file explains at length why `Get-Command bash` is
    // the wrong probe, and that prose is worth keeping.
    const code = read(HELPER).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(code, /Get-Command|which bash|command -v bash|execSync/,
      'the choice must follow from the platform, not from probing for a bash');
  });

  it('builds all four matcher entries with the platform-correct command', () => {
    const entries = sessionStartEntries({ platform: 'win32', hookDir: 'C:/Users/adam/.claude/hooks' });
    assert.equal(entries.length, 4);
    assert.deepEqual(entries.map((e) => e.matcher), MATCHERS);
    for (const e of entries) {
      assert.equal(e.hooks.length, 1);
      assert.match(e.hooks[0].command, /^node /,
        'the rewrite path is exactly where the Node command was being lost');
      assert.equal(e.hooks[0].type, 'command');
      assert.equal(e.hooks[0].timeout, 10);
    }
  });

  it('reproduces the defect: rewriting a Windows install must not yield a bash command', () => {
    // The precise sequence that broke every Windows machine. install.ps1 writes one
    // matcher-less entry running Node; update.ps1 finds it, decides the matchers are
    // incomplete, and rebuilds. Before this change the rebuild hardcoded bash.
    const hookDir = 'C:/Users/adam/.claude/hooks';
    const installed = [{ hooks: [{ type: 'command', command: sessionStartCommand({ platform: 'win32', hookDir }), timeout: 10 }] }];
    const hasAll = MATCHERS.every((m) => installed.some((h) => h.matcher === m));
    assert.equal(hasAll, false, 'the migration branch must be the one that fires here');

    const rebuilt = sessionStartEntries({ platform: 'win32', hookDir });
    for (const e of rebuilt) {
      assert.doesNotMatch(e.hooks[0].command, /bash/,
        'the daily update would replace a working Node hook with a bash one again');
    }
  });
});

describe('needsRewrite — the check that decides whether any Windows machine gets repaired', () => {
  const { sessionStartCommand, sessionStartEntries, needsRewrite } = require_(path.join(repoRoot, HELPER));
  const winOpts = { platform: 'win32', hookDir: 'C:/Users/adam/.claude/hooks' };
  const bashEntries = MATCHERS.map((matcher) => ({
    matcher,
    hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-session-start.sh', timeout: 10 }],
  }));

  it('repairs a Windows machine whose four matchers are complete but run bash', () => {
    // This is the exact state of every affected machine right now. If this returns false,
    // the release ships and not one of the six machines is fixed.
    assert.equal(needsRewrite(bashEntries, winOpts), true);
  });

  it('leaves a Mac alone — its bash entries are correct and working', () => {
    assert.equal(needsRewrite(bashEntries, { platform: 'darwin' }), false,
      '12,000 working hook loads run through these entries; touching them risks the platform that works');
  });

  it('repairs the matcher-less Node entry install.ps1 writes', () => {
    const installed = [{ hooks: [{ type: 'command', command: sessionStartCommand(winOpts), timeout: 10 }] }];
    assert.equal(needsRewrite(installed, winOpts), true);
  });

  it('is idempotent once repaired, so a daily update stops rewriting settings.json', () => {
    assert.equal(needsRewrite(sessionStartEntries(winOpts), winOpts), false);
    assert.equal(needsRewrite(sessionStartEntries({ platform: 'darwin' }), { platform: 'darwin' }), false);
  });

  it('says no when there is nothing of ours to rewrite', () => {
    // An empty list means the user has no OwnMind entry. That is the fresh-install branch
    // or a deliberate opt-out, and neither is this function's business.
    assert.equal(needsRewrite([], winOpts), false);
  });

  it("repairs 采瑤's real machine: one unquoted entry becomes four", () => {
    // Her exact settings on 2026-08-06. Her AI hand-wrote a working Node command without
    // quotes; v1.26.82 read that as a customisation and left her on a single matcher, so
    // memories loaded on a new conversation and not on resume, clear or compact.
    const opts = { platform: 'win32', hookDir: 'C:/Users/Celia/.claude/hooks' };
    const hers = [{ matcher: null, hooks: [{ type: 'command', command: 'node C:/Users/Celia/.ownmind/hooks/ownmind-session-start.js' }] }];
    assert.equal(needsRewrite(hers, opts), true);
  });

  it("repairs Adam's machine, whose command pointed at a copy that cannot run", () => {
    // Everything looked right here: four matchers, Node, the file present. The path was
    // ~/.claude/hooks, where the hook's own `../shared/helpers.js` import cannot resolve,
    // so it died on startup and reported nothing. v1.26.84 called this healthy.
    const opts = { platform: 'win32', ownmindDir: 'C:/Users/Adam/.ownmind' };
    const his = MATCHERS.map((matcher) => ({
      matcher,
      hooks: [{ type: 'command', command: 'node "C:/Users/Adam/.claude/hooks/ownmind-session-start.js"', timeout: 10 }],
    }));
    assert.equal(needsRewrite(his, opts), true);
  });

  it('leaves a machine already on the working path alone', () => {
    const opts = { platform: 'win32', ownmindDir: 'C:/Users/Celia/.ownmind' };
    const hers = sessionStartEntries(opts);
    assert.equal(needsRewrite(hers, opts), false, 'a daily rewrite would churn settings.json');
  });

  it('leaves a command the user edited themselves alone', () => {
    // Without this the updater silently undoes a deliberate edit every day, forever, and
    // the user has no way to win the argument.
    const customised = MATCHERS.map((matcher) => ({
      matcher,
      hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-session-start.sh --verbose', timeout: 10 }],
    }));
    assert.equal(needsRewrite(customised, winOpts), false);
    assert.equal(needsRewrite(customised, { platform: 'darwin' }), false);
  });
});

describe('isOwnmindSessionEntry / isGeneratedCommand — what counts as ours', () => {
  const { isOwnmindSessionEntry, isGeneratedCommand, sessionStartCommand } =
    require_(path.join(repoRoot, HELPER));

  it('does not claim the iron-rule hook', () => {
    // Loosening this match to "ownmind" would make the updater delete the PreToolUse
    // iron-rule entry out of SessionStart handling. Nothing else in these tests would
    // notice, because every other case feeds it a genuine session-start entry.
    const ironRule = { hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-iron-rule-check.sh' }] };
    assert.equal(isOwnmindSessionEntry(ironRule), false);
  });

  it('claims both platforms\' session-start entries', () => {
    for (const command of [
      'bash ~/.claude/hooks/ownmind-session-start.sh',
      sessionStartCommand({ platform: 'win32', hookDir: 'C:/Users/a/.claude/hooks' }),
    ]) {
      assert.equal(isOwnmindSessionEntry({ hooks: [{ command }] }), true, command);
    }
  });

  // Measured on 采瑤's machine, 2026-08-06. Her AI hand-wrote a working Node command
  // without quotes. `isGeneratedCommand` said no, `needsRewrite` said no, and the upgrade
  // left her with one matcher instead of four — memories load on a new conversation and
  // not on resume, clear or compact. Quoting is spelling, not intent: a command whose
  // whole job is running our own hook file is ours to maintain however it was written.
  // Extra flags or a different program are what make it somebody's deliberate edit.
  it('claims a command that runs our hook file even when it is written differently', () => {
    for (const c of [
      'node C:/Users/Celia/.ownmind/hooks/ownmind-session-start.js',
      'node "C:/Users/Celia/.claude/hooks/ownmind-session-start.js"',
      "node 'C:/x/ownmind-session-start.js'",
      'bash ~/.claude/hooks/ownmind-session-start.sh',
      // A Windows home directory routinely contains a space. An unquoted command with a
      // space is still just our hook — reading it as a customisation would exclude exactly
      // the users this repair exists for.
      'node C:/Users/Jane Doe/.claude/hooks/ownmind-session-start.js',
      'node C:\\Users\\Jane Doe\\.ownmind\\hooks\\ownmind-session-start.js',
    ]) {
      assert.equal(isGeneratedCommand(c), true, c);
    }
  });

  it('still leaves a genuinely customised command alone', () => {
    for (const c of [
      'bash ~/.claude/hooks/ownmind-session-start.sh --verbose',
      'node C:/x/ownmind-session-start.js --debug',
      'my-wrapper node C:/x/ownmind-session-start.js',
      'node C:/x/some-other-hook.js',
    ]) {
      assert.equal(isGeneratedCommand(c), false, c);
    }
  });

  it('handles absent and empty commands', () => {
    assert.equal(isGeneratedCommand(''), false);
    assert.equal(isGeneratedCommand(undefined), false);
  });
});

describe('the scripts that write settings.json all go through the helper', () => {
  // v1.26.86 — the updaters no longer touch SessionStart themselves at all: they run
  // ensure-session-hook.cjs (which consumes session-hook-command.cjs and has behavioural
  // tests of its own). "Asks the helper" now means that delegation.
  it('update.ps1 no longer hardcodes the bash command', () => {
    const src = read('scripts/update.ps1');
    assert.doesNotMatch(src, /const ownmindCmd = 'bash ~\/\.claude/,
      'this literal is what overwrote the Node hook on every Windows machine, daily');
    assert.match(src, /ensure-session-hook\.cjs/, 'update.ps1 must delegate to the helper');
  });

  it('update.sh no longer hardcodes the bash command', () => {
    const src = read('scripts/update.sh');
    assert.doesNotMatch(src, /const ownmindCmd = 'bash ~\/\.claude/);
    assert.match(src, /ensure-session-hook\.cjs/, 'update.sh must delegate to the helper');
  });

  it('install.ps1 no longer decides by probing for bash', () => {
    const src = read('install.ps1');
    assert.doesNotMatch(src, /\$HasBash\s*=\s*\$null -ne \(Get-Command bash/,
      'a bash on PATH is usually WSL, whose ~ is a different home directory');
    assert.match(src, /ensure-session-hook\.cjs/, 'install.ps1 must delegate to the helper');
  });

  it('install.sh keeps working through the helper too', () => {
    // v1.26.86 — the installers no longer reason about entries themselves; they run
    // ensure-session-hook.cjs, which is where session-hook-command.cjs is consumed and
    // which has behavioural tests of its own (tests/ensure-session-hook.test.js).
    assert.match(read('install.sh'), /ensure-session-hook\.cjs/);
  });

  // The installers must REPAIR, not only ADD. Found while working out how 采瑤 could
  // verify this release on her own machine, and it would have made the release
  // unverifiable by exactly the people it is for:
  //
  //   bootstrap.ps1 → interactive-upgrade.ps1 → install.ps1   (never runs update.ps1)
  //   install.ps1: `if (-not $sessionExists) { … }`           (she has entries, so: skip)
  //
  // Every affected user already has a SessionStart entry — a broken one. An installer that
  // skips when anything exists cannot fix any of them, and the only path that can is the
  // auto-update, which on 采瑤's machine has run twice in a month. The repair would have
  // sat on a road she does not travel. Same defect this whole day has been about.
  // v1.26.86 — "repair, not only add" now lives in ensure-session-hook.cjs for every
  // caller. The PowerShell version of this logic was never once executed on a real machine:
  // 采瑤 upgraded to v1.26.84 and her single null matcher survived it untouched.
  for (const rel of ['install.ps1', 'install.sh']) {
    it(`${rel} delegates the repair to the shared script`, () => {
      assert.match(read(rel), /ensure-session-hook\.cjs/);
    });
  }

});

describe('the Node hook the Windows command points at', () => {
  it('exists', () => {
    assert.ok(fs.existsSync(path.join(repoRoot, 'hooks/ownmind-session-start.js')),
      'the Windows command names a file that must be there');
  });

  it('is copied to the hook directory by the Windows installer', () => {
    const src = read('install.ps1');
    assert.match(src, /ownmind-session-start\.js/,
      'the command would point at a file the installer never places');
  });

  it('is copied by update.ps1 as well, so it stays current', () => {
    // update.ps1 syncs *.sh hooks. If it never refreshes the .js one, Windows users keep
    // whatever shipped on install day — the same shape as the scheduler defect: correct at
    // install, never maintained afterwards.
    const src = read('scripts/update.ps1');
    assert.match(src, /ownmind-session-start\.js|\*\.js/,
      'the Node hook is never refreshed on Windows after install');
  });
});
