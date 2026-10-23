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

test('xcodeStub puts a git on PATH that only complains, and an xcode-select that says no tools', () => {
  const mac = makeCleanMac({ xcodeStub: true });
  try {
    assert.equal(inMac(mac, 'command -v git').status, 0, 'a real clean Mac has /usr/bin/git, so git must be found');
    assert.equal(fs.existsSync(mac.gitMarker), false);
    const git = inMac(mac, 'git --version');
    assert.equal(git.status, 1);
    assert.match(git.stderr, /xcode-select: note: No developer tools were found, requesting install\./);
    assert.equal(fs.existsSync(mac.gitMarker), true, 'running the stub leaves the marker');
    assert.equal(inMac(mac, '"$OWNMIND_XCODE_SELECT" -p').status, 2);
    assert.equal(mac.env.OWNMIND_GIT_STUB_DIR, mac.binDir);
  } finally {
    mac.cleanup();
  }
});

test('without xcodeStub there is no git, no xcode-select and no marker seam in env', () => {
  const mac = makeCleanMac();
  try {
    assert.notEqual(inMac(mac, 'command -v xcode-select').status, 0);
    assert.equal(mac.env.OWNMIND_XCODE_SELECT, undefined);
  } finally {
    mac.cleanup();
  }
});
