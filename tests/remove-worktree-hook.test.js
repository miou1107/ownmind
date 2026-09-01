/**
 * bug-report id=29 — every `EnterWorktree` on the machine failed, in every repository.
 *
 * OwnMind registered `ownmind-worktree-setup.sh` as a WorktreeCreate hook to drop a
 * `.mcp.json` into each new worktree. That event is not a notification: Claude Code treats a
 * configured WorktreeCreate hook as the thing that CREATES the worktree and expects the new
 * path on stdout. A side-effect hook that prints nothing therefore answers
 * "hook succeeded but returned no worktree path", and worktrees stop working everywhere —
 * not only in the repository being worked on.
 *
 * The registration is what has to go, and it has to go from machines that already carry it.
 * An installer that merely stops adding it repairs nobody: everyone affected is already
 * installed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const require = createRequire(import.meta.url);
const { removeWorktreeHook } = require('../scripts/install-helpers/remove-worktree-hook.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));

function tempSettings(contents) {
  const dir = tempDir('ownmind-worktree-');
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
  return file;
}

/** Read it back with a real JSON parser rather than a substring check. */
function readBack(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const OWNMIND_ENTRY = {
  hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ownmind-worktree-setup.sh', timeout: 10 }],
};

test('the entry OwnMind registered is removed', () => {
  const file = tempSettings({ hooks: { WorktreeCreate: [OWNMIND_ENTRY] } });

  const result = removeWorktreeHook(file);

  assert.equal(result.status, 'ok');
  assert.equal(result.removed, 1);
  assert.equal(readBack(file).hooks.WorktreeCreate, undefined);
});

test('the WorktreeCreate key itself goes away, so Claude Code goes back to creating worktrees with git', () => {
  // An empty array is not the same as no key: Claude Code branches on whether a
  // WorktreeCreate hook is configured, and `[]` still reads as "configured" to a reader that
  // only asks whether the key is there.
  const file = tempSettings({ hooks: { SessionStart: [], WorktreeCreate: [OWNMIND_ENTRY] } });

  removeWorktreeHook(file);

  const settings = readBack(file);
  assert.ok(!('WorktreeCreate' in settings.hooks));
  assert.deepEqual(settings.hooks.SessionStart, []);
});

test("somebody else's WorktreeCreate hook is left where it is", () => {
  const theirs = { hooks: [{ type: 'command', command: 'bash ~/bin/make-sapling-worktree.sh' }] };
  const file = tempSettings({ hooks: { WorktreeCreate: [OWNMIND_ENTRY, theirs] } });

  const result = removeWorktreeHook(file);

  assert.equal(result.removed, 1);
  assert.deepEqual(readBack(file).hooks.WorktreeCreate, [theirs]);
});

test('an entry that mixes ours in with theirs loses only ours', () => {
  const mixed = {
    hooks: [
      { type: 'command', command: 'bash ~/.claude/hooks/ownmind-worktree-setup.sh', timeout: 10 },
      { type: 'command', command: 'bash ~/bin/make-sapling-worktree.sh' },
    ],
  };
  const file = tempSettings({ hooks: { WorktreeCreate: [mixed] } });

  const result = removeWorktreeHook(file);

  assert.equal(result.removed, 1);
  assert.deepEqual(readBack(file).hooks.WorktreeCreate, [
    { hooks: [{ type: 'command', command: 'bash ~/bin/make-sapling-worktree.sh' }] },
  ]);
});

test('running it a second time reports nothing to do and rewrites nothing', () => {
  const file = tempSettings({ hooks: { WorktreeCreate: [OWNMIND_ENTRY] } });
  removeWorktreeHook(file);
  const after = fs.readFileSync(file, 'utf8');

  const result = removeWorktreeHook(file);

  assert.equal(result.status, 'ok');
  assert.equal(result.removed, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), after);
});

test('a settings file that never had the hook is left byte-for-byte alone', () => {
  const original = JSON.stringify({ hooks: { SessionStart: [{ hooks: [] }] } }, null, 2);
  const file = tempSettings(original);

  const result = removeWorktreeHook(file);

  assert.equal(result.removed, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('the rest of settings.json survives the rewrite', () => {
  const file = tempSettings({
    mcpServers: { ownmind: { command: 'node', env: { OWNMIND_API_URL: 'https://example.test' } } },
    permissions: { allow: ['Bash(git status)'] },
    hooks: { WorktreeCreate: [OWNMIND_ENTRY], Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] },
  });

  removeWorktreeHook(file);

  const settings = readBack(file);
  assert.equal(settings.mcpServers.ownmind.env.OWNMIND_API_URL, 'https://example.test');
  assert.deepEqual(settings.permissions.allow, ['Bash(git status)']);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'x');
});

test('unparseable settings.json is reported and not overwritten', () => {
  // Truncating a settings file people hand-edit is worse than leaving the hook in place.
  const broken = '{ "hooks": { "WorktreeCreate": [ ';
  const file = tempSettings(broken);

  const result = removeWorktreeHook(file);

  assert.equal(result.status, 'error');
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
});

test('a missing settings.json is not an error — there is nothing to repair', () => {
  const dir = tempDir('ownmind-worktree-');
  const file = path.join(dir, 'settings.json');

  const result = removeWorktreeHook(file);

  assert.equal(result.status, 'ok');
  assert.equal(result.removed, 0);
  assert.equal(fs.existsSync(file), false);
});

test('the hook script is no longer shipped', () => {
  // Leaving the file behind invites the next installer to wire it up again.
  const script = path.join(HERE, '..', 'hooks', 'ownmind-worktree-setup.sh');
  assert.equal(fs.existsSync(script), false);
});

const INSTALLERS = [
  'install.sh', 'install.ps1',
  path.join('scripts', 'update.sh'), path.join('scripts', 'update.ps1'),
];

function installerSource(rel) {
  return fs.readFileSync(path.join(HERE, '..', rel), 'utf8');
}

/** The same file with its comment lines gone — a comment mentioning the helper is not a call. */
function installerCode(rel) {
  return installerSource(rel)
    .split(/\r?\n/)
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join('\n');
}

test('no installer registers a WorktreeCreate hook any more', () => {
  for (const rel of INSTALLERS) {
    // Naming the event while removing it is fine; adding an entry to it is not.
    assert.equal(
      /WorktreeCreate\s*(\.push|\[)/.test(installerSource(rel)), false,
      `${rel} still writes into hooks.WorktreeCreate`,
    );
  }
});

test('every installer runs the removal, so an upgrade repairs the machine', () => {
  // Without this, deleting the call from any one script leaves the whole suite green while
  // that population stays broken — and this mechanism has been reported four times.
  //
  // Matching the bare name was the first attempt and it was worthless: every call site has a
  // comment above it naming the same file, so the comment alone satisfied it. The assertion
  // is on `node …` running the thing.
  for (const rel of INSTALLERS) {
    assert.match(
      installerCode(rel),
      /node\s[^\n]*(remove-worktree-hook|\$REMOVE_WORKTREE_HOOK|\$RemoveWorktreeHook)/,
      `${rel} never runs the removal, so machines it upgrades keep the broken registration`,
    );
  }
});
