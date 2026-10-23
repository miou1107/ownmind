import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeCleanMac } from './helpers/clean-mac-sim.mjs';

/** Run a shell snippet inside the simulated machine, the way an installer would see it. */
function inMac(mac, script) {
  return spawnSync('sh', ['-c', script], { env: mac.env, encoding: 'utf8' });
}

test('git, node, npm and brew are not found; curl and tar are', () => {
  const mac = makeCleanMac();
  try {
    for (const tool of ['git', 'node', 'npm', 'brew']) {
      assert.notEqual(inMac(mac, `command -v ${tool}`).status, 0, `${tool} must not be on the simulated PATH`);
    }
    for (const tool of ['curl', 'tar', 'bash', 'osascript']) {
      assert.equal(inMac(mac, `command -v ${tool}`).status, 0, `${tool} must be on the simulated PATH`);
    }
  } finally {
    mac.cleanup();
  }
});

test('HOME is a fresh empty directory and PATH is only the helper bin', () => {
  const mac = makeCleanMac();
  try {
    assert.equal(mac.env.HOME, mac.home);
    assert.equal(mac.env.PATH, mac.binDir);
    assert.equal('CLAUDECODE' in mac.env, false);
    assert.deepEqual(fs.readdirSync(mac.home), []);
    assert.equal(inMac(mac, 'echo "$HOME"').stdout.trim(), mac.home);
    assert.ok(path.isAbsolute(mac.binDir));
    assert.ok(!mac.binDir.startsWith(mac.home), 'bin must live outside HOME so HOME stays empty');
  } finally {
    mac.cleanup();
  }
});

test('the real HOME and Claude Code variables do not leak in', () => {
  const saved = { c: process.env.CLAUDECODE, e: process.env.CLAUDE_CODE_ENTRYPOINT };
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  const mac = makeCleanMac();
  try {
    assert.notEqual(mac.env.HOME, os.homedir());
    assert.equal(mac.env.CLAUDECODE, undefined);
    assert.equal(mac.env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(inMac(mac, 'echo "${CLAUDECODE:-unset}"').stdout.trim(), 'unset');
    // Tools that follow XDG or git conventions cannot reach a config outside the throwaway home.
    assert.equal(mac.env.GIT_CONFIG_GLOBAL, path.join(mac.home, '.gitconfig'));
    assert.equal(mac.env.XDG_CONFIG_HOME, path.join(mac.home, '.config'));
  } finally {
    mac.cleanup();
    for (const [k, v] of [['CLAUDECODE', saved.c], ['CLAUDE_CODE_ENTRYPOINT', saved.e]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('the keep list can be changed, and a tool that does not exist is skipped', () => {
  const mac = makeCleanMac({ keep: ['sh', 'ls', 'no-such-tool-xyz'] });
  try {
    assert.equal(inMac(mac, 'command -v ls').status, 0);
    assert.notEqual(inMac(mac, 'command -v curl').status, 0);
    assert.notEqual(inMac(mac, 'command -v no-such-tool-xyz').status, 0);
  } finally {
    mac.cleanup();
  }
});

test('cleanup removes the home and the bin, and is safe to call twice', () => {
  const mac = makeCleanMac();
  mac.cleanup();
  assert.equal(fs.existsSync(mac.home), false);
  assert.equal(fs.existsSync(mac.binDir), false);
  mac.cleanup();
});
