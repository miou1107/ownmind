import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const helper = require('../scripts/install-helpers/add-post-tool-use-hook.cjs');

let tmpDir;
let settingsPath;
const OWNMIND_DIR = '/Users/test/.ownmind';

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-hook-install-'));
  settingsPath = path.join(tmpDir, 'settings.json');
}
function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('v1.17.71 — add-post-tool-use-hook idempotent merge', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('settings.json 不存在 → status=created', () => {
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'created');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(Array.isArray(s.hooks.PostToolUse));
    assert.equal(s.hooks.PostToolUse.length, 1);
    assert.equal(s.hooks.PostToolUse[0].matcher, 'mcp__ownmind__.*');
    assert.match(s.hooks.PostToolUse[0].hooks[0].command, /ownmind-tty-echo\.cjs/);
  });

  it('settings.json 存在但無 hooks 區塊 → status=added、保留既有設定', () => {
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

  it('已有其他 PostToolUse hook → 加在 array 末尾不影響既有', () => {
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

  it('已有 OwnMind hook → status=skipped、不重複加', () => {
    helper.addHook(settingsPath, OWNMIND_DIR);
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'skipped');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(s.hooks.PostToolUse.length, 1, 'idempotent — 不重複加');
  });

  it('壞掉的 JSON → status=error，settings.json 不被改', () => {
    fs.writeFileSync(settingsPath, '{ this is not valid json');
    const original = fs.readFileSync(settingsPath, 'utf8');
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'error');
    assert.match(r.message, /JSON parse/);
    // 原檔不該被改
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
  });

  it('成功 add 時要 backup 既有檔', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ existing: 'data' }));
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'added');
    // backup 應該存在於同目錄、檔名 settings.json.bak.*
    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('settings.json.bak.'));
    assert.equal(backups.length, 1, '應該有恰好 1 個 backup');
    const backupContent = JSON.parse(fs.readFileSync(path.join(tmpDir, backups[0]), 'utf8'));
    assert.equal(backupContent.existing, 'data', 'backup 應含原始內容');
  });

  it('hook command 用絕對 path（避免 PATH 解析爛掉）', () => {
    const r = helper.addHook(settingsPath, '/abs/path/.ownmind');
    assert.equal(r.status, 'created');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const cmd = s.hooks.PostToolUse[0].hooks[0].command;
    assert.match(cmd, /\/abs\/path\/\.ownmind\/hooks\/ownmind-tty-echo\.cjs/);
    assert.ok(cmd.startsWith('node '), 'command 應以 node 開頭');
  });

  it('matcher 是 mcp__ownmind__.*（只攔 OwnMind 工具，不影響其他 MCP）', () => {
    helper.addHook(settingsPath, OWNMIND_DIR);
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(s.hooks.PostToolUse[0].matcher, 'mcp__ownmind__.*');
  });
});
