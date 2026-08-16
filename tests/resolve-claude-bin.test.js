/**
 * The judge could not start the CLI on Windows, and said the CLI was not installed.
 *
 * Measured on Windows 10 / node v25.8.1 with the CLI installed through npm, before the fix:
 *
 *     spawn('claude')      -> ENOENT   (node does not apply PATHEXT)
 *     spawn('claude.cmd')  -> EINVAL   (node refuses a .cmd without a shell)
 *
 * Every judge run on that machine therefore returned `outcome: 'failed', failure: 'no-cli'`
 * with the sentence "claude is not on this machine" — about a machine holding
 * `C:\Users\…\AppData\Roaming\npm\claude.cmd`. The whole reply-quality check was off on
 * Windows, and the one message pointing at the cause pointed the wrong way.
 *
 * These tests run on every platform. That is the point: the defect existed for as long as it
 * did because it can only be *observed* on Windows, so the resolver takes its platform, its
 * environment and its filesystem as arguments and every case here is reachable from Linux and
 * macOS. The two Windows-only tests at the bottom are the ones that need the real operating
 * system to mean anything, and they are extra, not the whole coverage.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tempDir } from './helpers/temp-dir.js';
import { resolveClaudeBin, targetFromShim } from '../hooks/lib/resolve-claude-bin.js';

/** A PATH-like directory holding whichever files a case needs. */
function binDir(files) {
  const dir = tempDir('om-resolve-bin-');
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

const winEnv = (dir) => ({ PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' });

describe('resolveClaudeBin', () => {
  test('off Windows the name is handed straight back, untouched', () => {
    const out = resolveClaudeBin('claude', { platform: 'darwin', env: {} });
    assert.deepEqual(out, { command: 'claude', prefixArgs: [] });
  });

  test('a real executable is spawned directly, with no wrapper', () => {
    const dir = binDir({ 'claude.exe': 'MZ binary' });
    const out = resolveClaudeBin('claude', { platform: 'win32', env: winEnv(dir), sep: path.delimiter });

    assert.equal(out.command, path.join(dir, 'claude.exe'));
    assert.deepEqual(out.prefixArgs, [], 'an .exe needs nothing in front of it');
  });

  test('an npm shim is unwrapped to the node script it would have run', () => {
    // The shape npm actually generates, `%dp0%` and all.
    const dir = binDir({
      'claude.cmd': [
        '@ECHO off',
        'SETLOCAL',
        'CALL :find_dp0',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\cli.js" %*',
      ].join('\r\n'),
      'cli.js': '// the real entry point',
    });

    const out = resolveClaudeBin('claude', { platform: 'win32', env: winEnv(dir), nodeExec: '/usr/bin/node', sep: path.delimiter });

    assert.equal(out.command, '/usr/bin/node', 'run it with the node we are already inside');
    assert.deepEqual(out.prefixArgs, [path.join(dir, 'cli.js')]);
  });

  test('a shim wrapping a native executable is unwrapped to that executable', () => {
    // The shape Claude Code actually installs, copied from
    // C:\Users\…\AppData\Roaming\npm\claude.cmd on 2026-08-16. The first version of this fix
    // looked for a .js target only, passed every test written for it, and could not start the
    // real CLI. This case is that machine, in a temp directory.
    const dir = binDir({
      'claude.cmd': [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        '"%dp0%\\real-claude.exe"   %*',
      ].join('\r\n'),
      'real-claude.exe': 'MZ binary',
    });

    const out = resolveClaudeBin('claude', { platform: 'win32', env: winEnv(dir), nodeExec: 'node', sep: path.delimiter });

    assert.equal(out.command, path.join(dir, 'real-claude.exe'));
    assert.deepEqual(out.prefixArgs, [], 'an .exe target is run on its own, not through node');
  });

  test('a hand-written shim naming a sibling by plain name is read too', () => {
    const dir = binDir({
      'claude.cmd': '@echo off\r\nnode "claude.js" %*\r\n',
      'claude.js': '// entry',
    });

    const out = resolveClaudeBin('claude', { platform: 'win32', env: winEnv(dir), nodeExec: 'node', sep: path.delimiter });
    assert.deepEqual(out.prefixArgs, [path.join(dir, 'claude.js')]);
  });

  test('an .exe wins over a .cmd sitting beside it', () => {
    const dir = binDir({
      'claude.exe': 'MZ',
      'claude.cmd': '@echo off\r\nnode "claude.js" %*\r\n',
      'claude.js': '// entry',
    });
    const out = resolveClaudeBin('claude', { platform: 'win32', env: winEnv(dir), sep: path.delimiter });
    assert.equal(path.extname(out.command), '.exe');
  });

  test('an absolute path to a .cmd is unwrapped as well — that is the EINVAL case', () => {
    const dir = binDir({
      'claude.cmd': '@echo off\r\nnode "claude.js" %*\r\n',
      'claude.js': '// entry',
    });
    const out = resolveClaudeBin(path.join(dir, 'claude.cmd'), { platform: 'win32', env: {}, nodeExec: 'node' });
    assert.deepEqual(out.prefixArgs, [path.join(dir, 'claude.js')]);
  });

  test('a named file with an unfamiliar extension is handed back, not called missing', () => {
    // The POSIX-style install: an extensionless file the caller pointed straight at. Windows
    // may well refuse to start it, and that refusal is the operating system's to report —
    // answering `not-found` about a file the caller can see is this defect's own mistake.
    const dir = binDir({ claude: '#!/usr/bin/env node\n' });
    const explicit = path.join(dir, 'claude');

    const out = resolveClaudeBin(explicit, { platform: 'win32', env: {} });
    assert.deepEqual(out, { command: explicit, prefixArgs: [] });
  });

  test('a shim naming no node script fails as "installed but unusable", not as missing', () => {
    const dir = binDir({ 'claude.cmd': '@echo off\r\nsomething-else.exe %*\r\n' });

    assert.throws(
      () => resolveClaudeBin('claude', { platform: 'win32', env: winEnv(dir), sep: path.delimiter }),
      (err) => {
        assert.equal(err.code, 'shim-unknown', 'the caller keys the user-facing sentence off this');
        assert.match(err.message, /claude\.cmd/, 'name the file, so the reader can look at it');
        return true;
      }
    );
  });

  test('a shim naming a script that is not there is not treated as a script', () => {
    const dir = binDir({ 'claude.cmd': '@echo off\r\nnode "gone.js" %*\r\n' });
    assert.throws(
      () => resolveClaudeBin('claude', { platform: 'win32', env: winEnv(dir), sep: path.delimiter }),
      (err) => err.code === 'shim-unknown'
    );
  });

  test('nothing on PATH is a plain not-found, and says how hard it looked', () => {
    const dir = binDir({});
    assert.throws(
      () => resolveClaudeBin('claude', { platform: 'win32', env: winEnv(dir), sep: path.delimiter }),
      (err) => {
        assert.equal(err.code, 'not-found');
        assert.match(err.message, /candidate/);
        return true;
      }
    );
  });

  test('the extensionless npm script beside the shim is never chosen', () => {
    // npm installs `claude` (a sh script) next to `claude.cmd`. Windows cannot execute the
    // first one, and picking it is how `spawn('claude')` ended in ENOENT to begin with.
    const dir = binDir({
      claude: '#!/bin/sh\nexec node cli.js "$@"\n',
      'claude.cmd': '@echo off\r\nnode "cli.js" %*\r\n',
      'cli.js': '// entry',
    });
    const out = resolveClaudeBin('claude', { platform: 'win32', env: winEnv(dir), nodeExec: 'node', sep: path.delimiter });
    assert.deepEqual(out.prefixArgs, [path.join(dir, 'cli.js')]);
  });
});

describe('targetFromShim', () => {
  test('returns null rather than guessing when there is no quoted target', () => {
    const dir = binDir({});
    assert.equal(targetFromShim(path.join(dir, 'claude.cmd'), '@echo off\r\nfoo %*\r\n'), null);
  });

  test('only the line that forwards argv is read', () => {
    // npm's node shim tests for a bundled interpreter on a line of its own. Reading the whole
    // file picks that up and runs the interpreter as if it were the target — which is what the
    // first version of this did.
    const dir = binDir({ 'node.exe': 'MZ', 'cli.js': '// entry' });
    const shim = [
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ')',
      '"%_prog%"  "%dp0%\\cli.js" %*',
    ].join('\r\n');

    const found = targetFromShim(path.join(dir, 'claude.cmd'), shim);
    assert.equal(found.target, path.join(dir, 'cli.js'), 'the branch not taken must not win');
    assert.equal(found.kind, 'node-script');
  });
});

/**
 * The two that need the real operating system.
 *
 * Everything above proves the resolver picks the right file. Only Windows can prove that the
 * file it picks can actually be started — and that the one it replaced could not, which is
 * the half that keeps this from being a test of its own assumptions.
 */
describe('on Windows, against the real spawn', { skip: process.platform !== 'win32' }, () => {
  const shimWorld = () => {
    const dir = tempDir('om-resolve-real-');
    fs.writeFileSync(path.join(dir, 'claude.js'), 'process.stdout.write("started:" + process.argv.slice(2).join(","));\n');
    fs.writeFileSync(path.join(dir, 'claude.cmd'), `@echo off\r\nnode "%~dp0\\claude.js" %*\r\n`);
    return dir;
  };

  const runIt = (command, args) => new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ error: err.code || err.message });
    }
    child.on('error', (err) => resolve({ error: err.code || err.message }));
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end();
  });

  test('the .cmd the old code spawned really is unstartable — the control', async () => {
    const dir = shimWorld();
    const got = await runIt(path.join(dir, 'claude.cmd'), ['--version']);
    assert.equal(got.error, 'EINVAL',
      'if this ever stops being EINVAL the fix is no longer load-bearing and should be revisited');
  });

  test('what the resolver returns starts, and carries argv through unmangled', async () => {
    const dir = shimWorld();
    const { command, prefixArgs } = resolveClaudeBin(path.join(dir, 'claude.cmd'), {});

    // An argument with the characters cmd.exe would have eaten. This is why the fix does not
    // use `shell: true`: the judge sends a multi-line system prompt through argv.
    const nasty = 'a b "c" %PATH% ^caret';
    const got = await runIt(command, [...prefixArgs, nasty]);

    assert.equal(got.code, 0, `expected a clean start, got ${JSON.stringify(got)}`);
    assert.equal(got.out, `started:${nasty}`, 'argv must arrive byte for byte');
  });
});
