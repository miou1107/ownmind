/**
 * Finding Windows' own binaries when PATH has lost them.
 *
 * Every case injects `env`, `platform` and `exists`, because the machine this was written
 * for cannot be reproduced on the machine it was written on — and a Windows-only test is a
 * test that runs on one CI leg and gets read by nobody.
 *
 * The report from that machine, for reference:
 *   mcp_launches  fail  could not spawn: spawn cmd.exe ENOENT
 *   scheduler     fail  Get-ScheduledTask failed: code=ENOENT spawn powershell.exe ENOENT
 * with chcp.com, powershell.exe and where.exe all silently producing nothing in the same run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveSystemBinary, describeSystemBinaries } = require('../scripts/install-helpers/win-system-binary.cjs');

/** A Windows whose System32 is on disk but not on PATH — the machine this exists for. */
const BROKEN_PATH = {
  platform: 'win32',
  env: {
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    Path: 'C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd',
  },
  exists: (p) => /^C:\\Windows\\(system32|System32)\\/i.test(p),
};

test('cmd.exe resolves through ComSpec, which is where Windows says it is', () => {
  assert.equal(resolveSystemBinary('cmd.exe', BROKEN_PATH), 'C:\\Windows\\system32\\cmd.exe');
});

test('powershell.exe resolves under System32 even with nothing helpful on PATH', () => {
  assert.equal(
    resolveSystemBinary('powershell.exe', BROKEN_PATH),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
});

test('the other three the self-check shells out to resolve too', () => {
  // where.exe, chcp.com and taskkill all failed silently in the same report — each one
  // turning a real answer into a null field rather than into an error anybody could see.
  for (const [name, tail] of [
    ['where.exe', 'where.exe'],
    ['chcp.com', 'chcp.com'],
    ['taskkill', 'taskkill.exe'],
  ]) {
    assert.equal(
      resolveSystemBinary(name, BROKEN_PATH), `C:\\Windows\\System32\\${tail}`,
      `${name} was left for PATH to find, and PATH is what is broken`,
    );
  }
});

test('an extension-less name resolves the same as its .exe twin', () => {
  // mcp-preflight.cjs spawns `taskkill`; the self-check spawns `powershell.exe`. A table
  // that covers one spelling looks like it works right up until the other caller runs.
  assert.equal(resolveSystemBinary('taskkill', BROKEN_PATH), resolveSystemBinary('taskkill.exe', BROKEN_PATH));
  assert.equal(resolveSystemBinary('cmd', BROKEN_PATH), resolveSystemBinary('cmd.exe', BROKEN_PATH));
});

test('nothing is touched off Windows', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.equal(resolveSystemBinary('cmd.exe', { ...BROKEN_PATH, platform }), 'cmd.exe');
  }
});

test('a path the caller already chose is left exactly as it was', () => {
  // The caller has said where it wants this from. Rewriting that would run a different
  // program than the one it asked for.
  for (const given of ['C:\\Other\\cmd.exe', './cmd.exe', '/usr/bin/where']) {
    assert.equal(resolveSystemBinary(given, BROKEN_PATH), given);
  }
});

test('a name that is not one of Windows own binaries is left alone', () => {
  assert.equal(resolveSystemBinary('node.exe', BROKEN_PATH), 'node.exe');
  assert.equal(resolveSystemBinary('git', BROKEN_PATH), 'git');
});

test('a machine with no SystemRoot still gets the standard location', () => {
  const noRoot = { ...BROKEN_PATH, env: { Path: '' } };
  assert.equal(resolveSystemBinary('where.exe', noRoot), 'C:\\Windows\\System32\\where.exe');
});

test('a relocated System32 falls back to the bare name rather than a path that is not there', () => {
  // Committing to an absolute path that does not exist would turn "PATH might still find
  // it" into a guaranteed ENOENT — a helper for reliability making one machine worse.
  const nothingExists = { ...BROKEN_PATH, exists: () => false };
  assert.equal(resolveSystemBinary('powershell.exe', nothingExists), 'powershell.exe');
  assert.equal(resolveSystemBinary('cmd.exe', nothingExists), 'cmd.exe');
});

test('ComSpec pointing at nothing does not win over System32', () => {
  const badComSpec = {
    ...BROKEN_PATH,
    env: { ...BROKEN_PATH.env, ComSpec: 'D:\\gone\\cmd.exe' },
  };
  assert.equal(resolveSystemBinary('cmd.exe', badComSpec), 'C:\\Windows\\System32\\cmd.exe');
});

test('the report says PATH is the broken part, not the binaries', () => {
  // This is the field whose absence cost a database query against production to answer a
  // question the machine already knew: is System32 on this PATH?
  const report = describeSystemBinaries(BROKEN_PATH);
  assert.deepEqual(report, {
    'cmd.exe': 'system32',
    'powershell.exe': 'system32',
    'where.exe': 'system32',
    'chcp.com': 'system32',
    'taskkill.exe': 'system32',
  });
});

test('a healthy machine reports every one of them as ordinary', () => {
  const healthy = {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32;C:\\Windows' },
    exists: () => true,
  };
  const report = describeSystemBinaries(healthy);
  assert.deepEqual(Object.values(report), Array(5).fill('path'),
    'a working machine must not produce a report that looks like a finding');
});

test('a machine that has neither says missing, and does not pretend otherwise', () => {
  const gone = { platform: 'win32', env: { Path: '' }, exists: () => false };
  assert.equal(describeSystemBinaries(gone)['powershell.exe'], 'missing');
});

test('the report is absent off Windows rather than empty', () => {
  // An empty object reads as "checked, found nothing"; null reads as "the question does not
  // apply here", and the two send a reader looking in different places.
  assert.equal(describeSystemBinaries({ platform: 'darwin' }), null);
});

test('an unreadable PATH entry does not take the report down with it', () => {
  const throwing = {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', Path: '\\\\dead-share\\x;C:\\Windows\\System32' },
    exists: (p) => {
      if (p.startsWith('\\\\dead-share')) throw new Error('EIO');
      return true;
    },
  };
  assert.equal(describeSystemBinaries(throwing)['cmd.exe'], 'path',
    'one unreachable network drive on PATH must not decide the whole answer');
});
