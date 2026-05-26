import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const helper = require('../scripts/install-helpers/add-stop-hook.cjs');

let tmpDir;
let settingsPath;
const OWNMIND_DIR = '/Users/test/.ownmind';

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-stop-hook-install-'));
  settingsPath = path.join(tmpDir, 'settings.json');
}
function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * v1.17.96 — Stop hook (reply-lint) installer helper. Same idempotent merge
 * semantics as v1.17.71 add-post-tool-use-hook, but injected at settings.json
 * hooks.Stop (not PostToolUse).
 */
describe('v1.17.96 — add-stop-hook idempotent merge', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('settings.json missing → status=created', () => {
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'created');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(Array.isArray(s.hooks.Stop));
    assert.equal(s.hooks.Stop.length, 1);
    assert.match(s.hooks.Stop[0].hooks[0].command, /ownmind-reply-lint\.js/);
  });

  it('settings.json exists but no hooks block → status=added, existing settings preserved', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      mcpServers: { ownmind: { command: 'node', args: ['x'] } },
      theme: 'dark',
    }));
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'added');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(s.theme, 'dark', 'existing user settings must be preserved');
    assert.equal(s.mcpServers.ownmind.command, 'node', 'mcpServers must be preserved');
    assert.ok(Array.isArray(s.hooks.Stop));
  });

  it('other Stop hooks already present → append at array end, do not disturb', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'echo other-stop-hook' }] },
        ],
      },
    }));
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'added');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(s.hooks.Stop.length, 2, 'existing hook should be preserved + new appended');
    assert.match(s.hooks.Stop[0].hooks[0].command, /echo other-stop-hook/);
    assert.match(s.hooks.Stop[1].hooks[0].command, /ownmind-reply-lint/);
  });

  it('OwnMind reply-lint hook already present → status=skipped, no duplicate add', () => {
    helper.addHook(settingsPath, OWNMIND_DIR);
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'skipped');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(s.hooks.Stop.length, 1, 'idempotent — no duplicate');
  });

  it('broken JSON → status=error, settings.json untouched', () => {
    fs.writeFileSync(settingsPath, '{ this is not valid json');
    const original = fs.readFileSync(settingsPath, 'utf8');
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'error');
    assert.match(r.message, /JSON parse/);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), original, 'original file must not change');
  });

  it('on successful add, must back up the existing file', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ existing: 'data' }));
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'added');
    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('settings.json.bak.'));
    assert.equal(backups.length, 1, 'should be exactly 1 backup');
    const backupContent = JSON.parse(fs.readFileSync(path.join(tmpDir, backups[0]), 'utf8'));
    assert.equal(backupContent.existing, 'data', 'backup should preserve the original content');
  });

  it('hook command uses an absolute path (avoid broken PATH resolution)', () => {
    const r = helper.addHook(settingsPath, '/abs/path/.ownmind');
    assert.equal(r.status, 'created');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const cmd = s.hooks.Stop[0].hooks[0].command;
    assert.match(cmd, /\/abs\/path\/\.ownmind\/hooks\/ownmind-reply-lint\.js/);
    assert.ok(cmd.startsWith('node '), 'command should start with node');
  });

  it('Stop hook does not need a matcher (Claude Code spec — Stop hook has no tool concept)', () => {
    helper.addHook(settingsPath, OWNMIND_DIR);
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // The Stop hook entry must not carry a matcher field.
    assert.equal(s.hooks.Stop[0].matcher, undefined, 'Stop hook must not carry a matcher');
  });

  // review-C2: atomic write failure → rollback, original file must not change.
  it('atomic write failure — original file stays intact + no leftover tmp file', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ existing: 'data' }));
    const original = fs.readFileSync(settingsPath, 'utf8');

    // Cause a write failure by turning settings.json into an unwritable layout.
    // Trick: pre-create settings.json.tmp as a directory — atomic write calls
    // fs.writeFileSync to the tmp path → it already exists as a dir → EISDIR → rollback.
    const tmpPath = `${settingsPath}.tmp`;
    fs.mkdirSync(tmpPath);
    try {
      const r = helper.addHook(settingsPath, OWNMIND_DIR);
      assert.equal(r.status, 'error', 'write failure should return error');
      assert.match(r.message, /write failed/i);
      assert.equal(fs.readFileSync(settingsPath, 'utf8'), original,
        'the original settings.json must stay intact');
    } finally {
      fs.rmdirSync(tmpPath);
    }
  });

  it('coexists with a PostToolUse hook — neither interferes', () => {
    // Simulate an existing PostToolUse hook (ownmind-tty-echo).
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: 'mcp__ownmind__.*', hooks: [{ type: 'command', command: 'node /tty-echo.cjs' }] },
        ],
      },
    }));
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'added');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(s.hooks.PostToolUse.length, 1, 'PostToolUse must not be touched');
    assert.equal(s.hooks.Stop.length, 1);
  });
});
