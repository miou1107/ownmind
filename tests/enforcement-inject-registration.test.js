import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = require(path.join(repoRoot, 'scripts', 'install-helpers', 'ensure-pretooluse-hooks.cjs'));

/**
 * The registration, asserted on the file that ends up on disk.
 *
 * A hook that ships without a settings entry is a hook that never runs, and every unit test
 * of its logic keeps passing - the shape of failure this whole feature exists to remove. So
 * these tests read `settings.json` after the installer helper has written it, rather than
 * grepping the helper's source for the word `UserPromptSubmit`, which a commented-out line
 * would satisfy.
 */

function settingsIn(dir) {
  return path.join(dir, 'settings.json');
}

function run(settingsPath, { useBash = true } = {}) {
  return helper.ensureHooks(settingsPath, '/tmp/ownmind-fake', useBash);
}

function read(settingsPath) {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

test('a fresh settings file gets the prompt hook alongside the tool hooks', () => {
  const file = settingsIn(tempDir('om-reg-'));
  fs.writeFileSync(file, '{}');
  const result = run(file);
  assert.equal(result.status, 'ok');

  const written = read(file);
  const commands = (written.hooks.UserPromptSubmit ?? [])
    .flatMap((group) => group.hooks ?? [])
    .map((h) => h.command);
  assert.equal(commands.length, 1, 'exactly one prompt hook should be registered');
  assert.match(commands[0], /ownmind-prompt-inject/);
  // The tool hooks must survive: this helper's whole job is repairing without clobbering.
  assert.equal(written.hooks.PreToolUse.length, helper.MATCHERS.length);
});

test('running twice does not register it twice', () => {
  const file = settingsIn(tempDir('om-reg-'));
  fs.writeFileSync(file, '{}');
  run(file);
  run(file);
  const groups = read(file).hooks.UserPromptSubmit;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].hooks.length, 1);
});

test('a stale command is repaired rather than left in place', () => {
  // Upgrades are the whole population. An installer that only appends never reaches anyone
  // who already has an entry, so a wrong command written once would stay wrong for ever.
  const file = settingsIn(tempDir('om-reg-'));
  fs.writeFileSync(file, JSON.stringify({
    hooks: {
      UserPromptSubmit: [{
        hooks: [{ type: 'command', command: 'node /old/path/ownmind-prompt-inject.js' }],
      }],
    },
  }));
  const result = run(file);
  assert.equal(result.status, 'ok');

  const commands = read(file).hooks.UserPromptSubmit
    .flatMap((group) => group.hooks ?? [])
    .map((h) => h.command);
  assert.equal(commands.length, 1);
  assert.ok(!commands[0].includes('/old/path/'), `stale command survived: ${commands[0]}`);
  assert.match(commands[0], /ownmind-prompt-inject/);
});

test('somebody else\'s prompt hook is left alone', () => {
  const file = settingsIn(tempDir('om-reg-'));
  fs.writeFileSync(file, JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /somebody/else/thing.js' }] }],
    },
  }));
  run(file);
  const commands = read(file).hooks.UserPromptSubmit
    .flatMap((group) => group.hooks ?? [])
    .map((h) => h.command);
  assert.ok(commands.includes('node /somebody/else/thing.js'), 'an unrelated hook was removed');
  assert.ok(commands.some((c) => /ownmind-prompt-inject/.test(c)), 'ours was not added');
});

test('the registered command points at a file that exists', () => {
  // The command is a path, and a path that is right in the installer and wrong on disk fails
  // at the only moment nobody is watching.
  const file = settingsIn(tempDir('om-reg-'));
  fs.writeFileSync(file, '{}');
  run(file, { useBash: false });
  const command = read(file).hooks.UserPromptSubmit[0].hooks[0].command;
  // The command quotes the path so a directory with a space still parses as one argument;
  // the quotes are part of the command, not part of the path.
  const hookPath = command
    .replace(/^node\s+/, '')
    .replace(/^"|"$/g, '')
    .replace('/tmp/ownmind-fake', repoRoot);
  assert.ok(fs.existsSync(hookPath), `registered path does not exist: ${hookPath}`);
});

test('an existing settings file is backed up before it is rewritten', () => {
  const dir = tempDir('om-reg-');
  const file = settingsIn(dir);
  fs.writeFileSync(file, JSON.stringify({ existingKey: 'keep me' }));
  run(file);
  assert.equal(read(file).existingKey, 'keep me', 'unrelated settings must survive');
  assert.ok(
    fs.readdirSync(dir).some((f) => f.startsWith('settings.json.bak.')),
    'no backup was written before the rewrite',
  );
});
