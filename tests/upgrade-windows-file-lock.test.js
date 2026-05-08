import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.84 — Windows file-lock detection during upgrade（vin-windows-test 第七輪）
 *
 * Root cause（Windows-specific）：
 *   OwnMind MCP server (cmd.exe + start.cmd → node mcp/index.js) 在 Claude Code session 內
 *   running，持有 ~/.ownmind/mcp/node_modules/*.js 的 read handle。
 *   git pull / npm install 想改寫這些檔案 → Windows mandatory locking 拒絕 → EBUSY / EPERM。
 *   user 的 AI 看到錯誤訊息推測「package.json 被佔用」，但 interactive-upgrade.ps1 沒明確識別
 *   這類 lock 錯誤、沒留下 IR-038 觀測紀錄。
 *
 * 修法：
 *   - interactive-upgrade.{sh,ps1}：失敗時檢查 log 是否含 file-lock 訊號（EBUSY / EACCES /
 *     "in use" / "another process" / "Permission denied"），若是則：
 *       1. Report-Error -Kind upgrade_file_locked
 *       2. 替換錯誤碼為 file_locked（不是泛 git_pull / npm_install）
 *       3. 給 user 明確指示：完整關閉 Claude Code 再重跑
 *   - check-sync.sh：L2 讀 client version 改用 grep 文字 fallback（lock-tolerant）
 */

describe('check-sync.sh — L2 client version 讀取要 lock-tolerant (v1.17.84)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/check-sync.sh'), 'utf8');

  it('L2 段落含 grep / sed fallback（不僅依賴 node -e require）', () => {
    // 失敗時 fallback 用 grep 抓 "version": "X.Y.Z" 文字，比 node require 更耐 lock
    assert.match(content, /grep[^\n]*version|sed[^\n]*version/i,
      'CLIENT_VER 讀取要有 grep/sed 文字 fallback（Windows file lock 時 node require 可能失敗）');
  });
});

describe('interactive-upgrade.sh — file-lock detection (v1.17.84)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/interactive-upgrade.sh'), 'utf8');

  it('含 file-lock pattern 偵測（EBUSY / EACCES / "in use" 等）', () => {
    assert.match(content, /EBUSY|EACCES|in use|another process|Permission denied/i,
      '需要偵測常見 file-lock 錯誤訊息');
  });

  it('lock 偵測到時 Report-Error kind=upgrade_file_locked', () => {
    assert.match(content, /upgrade_file_locked/);
  });

  it('lock 訊息明確要 user 關閉 Claude Code', () => {
    assert.match(content, /[Cc]lose.*Claude Code|[Cc]laude Code.*close|restart Claude/i,
      '要明確告訴 user 關閉 Claude Code 再重跑（不是泛 git pull failed）');
  });
});

describe('interactive-upgrade.ps1 — file-lock detection (v1.17.84)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/interactive-upgrade.ps1'), 'utf8');

  it('含 Windows file-lock pattern 偵測', () => {
    assert.match(content, /EBUSY|EACCES|in use|another process|Permission denied/i);
  });

  it('lock 偵測到時 Report-Error kind=upgrade_file_locked', () => {
    assert.match(content, /upgrade_file_locked/);
  });

  it('lock 訊息明確要 user 關閉 Claude Code', () => {
    assert.match(content, /[Cc]lose.*Claude Code|[Cc]laude Code.*close|restart Claude/i);
  });
});
