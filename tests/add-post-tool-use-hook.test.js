import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.js';

const require = createRequire(import.meta.url);
const helper = require('../scripts/install-helpers/add-post-tool-use-hook.cjs');

let tmpDir;
let settingsPath;
const OWNMIND_DIR = '/Users/test/.ownmind';

function setup() {
  tmpDir = tempDir('ownmind-hook-install-');
  settingsPath = path.join(tmpDir, 'settings.json');
}
function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('v1.17.71 — add-post-tool-use-hook idempotent merge', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('settings.json does not exist → status=created', () => {
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'created');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(Array.isArray(s.hooks.PostToolUse));
    assert.equal(s.hooks.PostToolUse.length, 1);
    assert.equal(s.hooks.PostToolUse[0].matcher, 'mcp__ownmind__.*');
    assert.match(s.hooks.PostToolUse[0].hooks[0].command, /ownmind-tty-echo\.cjs/);
  });

  it('settings.json exists but has no hooks block → status=added, existing config preserved', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      mcpServers: { ownmind: { command: 'node', args: ['x'] } },
      theme: 'dark',
    }));
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'added');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(s.theme, 'dark', '既有 user 設定必須保留');
    assert.equal(s.mcpServers.ownmind.command, 'node', 'mcpServers 必須保留');
    assert.ok(Array.isArray(s.hooks.PostToolUse));
  });

  it('other PostToolUse hooks already exist → append to end of array without affecting existing', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo other' }] },
        ],
      },
    }));
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'added');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(s.hooks.PostToolUse.length, 2, '原有 hook 應保留 + 新加');
    assert.equal(s.hooks.PostToolUse[0].matcher, 'Bash');
    assert.equal(s.hooks.PostToolUse[1].matcher, 'mcp__ownmind__.*');
  });

  it('OwnMind hook already exists → status=skipped, no duplicate added', () => {
    helper.addHook(settingsPath, OWNMIND_DIR);
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'skipped');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(s.hooks.PostToolUse.length, 1, 'idempotent — 不重複加');
  });

  it('broken JSON → status=error, settings.json is not modified', () => {
    fs.writeFileSync(settingsPath, '{ this is not valid json');
    const original = fs.readFileSync(settingsPath, 'utf8');
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'error');
    assert.match(r.message, /JSON parse/);
    // Original file should not be modified
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
  });

  it('backs up the existing file on successful add', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ existing: 'data' }));
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'added');
    // Backup should exist in the same directory, filename settings.json.bak.*
    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('settings.json.bak.'));
    assert.equal(backups.length, 1, '應該有恰好 1 個 backup');
    const backupContent = JSON.parse(fs.readFileSync(path.join(tmpDir, backups[0]), 'utf8'));
    assert.equal(backupContent.existing, 'data', 'backup 應含原始內容');
  });

  it('hook command uses absolute path (avoids broken PATH resolution)', () => {
    // v1.26.119 — the fake home is spelled for the platform under test, and the expectation
    // is built the same way the helper builds it. The old literal `/abs/path/...` could not
    // match on Windows, where path.join answers with backslashes, while the property being
    // asserted — an absolute path rather than a bare filename — was satisfied all along.
    const ownmindDir = path.resolve(
      process.platform === 'win32' ? 'C:\\abs\\path\\.ownmind' : '/abs/path/.ownmind');
    const r = helper.addHook(settingsPath, ownmindDir);
    assert.equal(r.status, 'created');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const cmd = s.hooks.PostToolUse[0].hooks[0].command;
    assert.ok(cmd.includes(path.join(ownmindDir, 'hooks', 'ownmind-tty-echo.cjs')),
      `expected the absolute hook path in the command, got: ${cmd}`);
    // The claim in the title, asserted directly rather than implied by the literal.
    const quoted = cmd.match(/"([^"]+)"/);
    assert.ok(quoted && path.isAbsolute(quoted[1]),
      `the hook path must be absolute, got: ${cmd}`);
    assert.ok(cmd.startsWith('node '), 'command 應以 node 開頭');
  });

  it('matcher is mcp__ownmind__.* (only intercepts OwnMind tools, does not affect other MCPs)', () => {
    helper.addHook(settingsPath, OWNMIND_DIR);
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(s.hooks.PostToolUse[0].matcher, 'mcp__ownmind__.*');
  });
});
