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
 * v1.17.96 — Stop hook（reply-lint）安裝 helper：跟 v1.17.71 add-post-tool-use-hook
 * 一樣的 idempotent 合併語意，但加在 settings.json 的 hooks.Stop（不是 PostToolUse）。
 */
describe('v1.17.96 — add-stop-hook idempotent merge', () => {
  beforeEach(setup);
  afterEach(cleanup);

  it('settings.json 不存在 → status=created', () => {
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'created');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(Array.isArray(s.hooks.Stop));
    assert.equal(s.hooks.Stop.length, 1);
    assert.match(s.hooks.Stop[0].hooks[0].command, /ownmind-reply-lint\.js/);
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
    assert.ok(Array.isArray(s.hooks.Stop));
  });

  it('已有其他 Stop hook → 加在 array 末尾不影響既有', () => {
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
    assert.equal(s.hooks.Stop.length, 2, '原有 hook 應保留 + 新加');
    assert.match(s.hooks.Stop[0].hooks[0].command, /echo other-stop-hook/);
    assert.match(s.hooks.Stop[1].hooks[0].command, /ownmind-reply-lint/);
  });

  it('已有 OwnMind reply-lint hook → status=skipped、不重複加', () => {
    helper.addHook(settingsPath, OWNMIND_DIR);
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'skipped');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(s.hooks.Stop.length, 1, 'idempotent — 不重複加');
  });

  it('壞掉的 JSON → status=error，settings.json 不被改', () => {
    fs.writeFileSync(settingsPath, '{ this is not valid json');
    const original = fs.readFileSync(settingsPath, 'utf8');
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'error');
    assert.match(r.message, /JSON parse/);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), original, '原檔不該被改');
  });

  it('成功 add 時要 backup 既有檔', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ existing: 'data' }));
    const r = helper.addHook(settingsPath, OWNMIND_DIR);
    assert.equal(r.status, 'added');
    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('settings.json.bak.'));
    assert.equal(backups.length, 1, '應該有恰好 1 個 backup');
    const backupContent = JSON.parse(fs.readFileSync(path.join(tmpDir, backups[0]), 'utf8'));
    assert.equal(backupContent.existing, 'data', 'backup 應含原始內容');
  });

  it('hook command 用絕對 path（避免 PATH 解析爛掉）', () => {
    const r = helper.addHook(settingsPath, '/abs/path/.ownmind');
    assert.equal(r.status, 'created');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const cmd = s.hooks.Stop[0].hooks[0].command;
    assert.match(cmd, /\/abs\/path\/\.ownmind\/hooks\/ownmind-reply-lint\.js/);
    assert.ok(cmd.startsWith('node '), 'command 應以 node 開頭');
  });

  it('Stop hook 不需要 matcher（Claude Code 規格 — Stop hook 沒有 tool 概念）', () => {
    helper.addHook(settingsPath, OWNMIND_DIR);
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // Stop hook entry 不該有 matcher 欄位
    assert.equal(s.hooks.Stop[0].matcher, undefined, 'Stop hook 不該有 matcher');
  });

  // review-C2：atomic write 失敗 → rollback、原檔不該被改
  it('atomic write 失敗時 — 原檔保持完整 + 沒留 tmp 檔', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ existing: 'data' }));
    const original = fs.readFileSync(settingsPath, 'utf8');

    // 製造寫入失敗：先把 settings.json 改成不可寫目錄結構
    // 用「目錄佔位 settings.json.tmp」這條 — atomic write 用 fs.writeFileSync 寫 tmp
    // → tmp path 已存在且是 dir → writeFileSync EISDIR → rollback
    const tmpPath = `${settingsPath}.tmp`;
    fs.mkdirSync(tmpPath);
    try {
      const r = helper.addHook(settingsPath, OWNMIND_DIR);
      assert.equal(r.status, 'error', '寫入失敗應回 error');
      assert.match(r.message, /write failed/i);
      assert.equal(fs.readFileSync(settingsPath, 'utf8'), original,
        '原 settings.json 必須保持完整不變');
    } finally {
      fs.rmdirSync(tmpPath);
    }
  });

  it('和 PostToolUse hook 共存 — 互不干擾', () => {
    // 模擬已經有 PostToolUse hook（ownmind-tty-echo）
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
    assert.equal(s.hooks.PostToolUse.length, 1, 'PostToolUse 不該被影響');
    assert.equal(s.hooks.Stop.length, 1);
  });
});
