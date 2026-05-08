import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.77 — start.cmd 必須在 PATH 找不到 node 時走 fallback（回報者：vin-windows-test 第二輪）
 *
 * Root cause（v1.17.76 沒修到的下一層）：
 *   - v1.17.76 的 install.ps1 在「裝 OwnMind 時」靠 Reload-Path 找到 node ✅
 *   - 但 winget 把 node 裝到 C:\Program Files\nodejs\，**沒永久寫入 User PATH**
 *   - Claude Code 在 install 之前就啟動了，它的 process PATH frozen 在啟動時
 *   - Claude Code spawn `cmd.exe /c start.cmd` → cmd.exe 繼承 Claude Code 的舊 PATH
 *     → `where node` 找不到 → MCP server 永遠起不來
 *
 * 修法（兩層守住）：
 *   1. start.cmd 加 fallback：where node → C:\Program Files\nodejs\node.exe →
 *      %ProgramFiles%\nodejs\node.exe → %LOCALAPPDATA%\Programs\nodejs\node.exe
 *   2. install.ps1 把 node 安裝目錄持久化寫入 User PATH（下次新 terminal / 重啟 Claude
 *      Code 後就會找到，不再依賴 fallback；但 fallback 仍守住「user 還沒重啟」的窗口）
 */

describe('mcp/start.cmd — 缺 node 時走 fallback (v1.17.77)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'mcp/start.cmd'), 'utf8');

  it('優先試 where node（PATH 已設定的快速路徑）', () => {
    assert.match(
      content,
      /where\s+node/i,
      '保留原有 where node lookup 當第一順位'
    );
  });

  it('fallback 試 C:\\Program Files\\nodejs\\node.exe（winget 預設位置）', () => {
    assert.match(
      content,
      /C:\\Program Files\\nodejs\\node\.exe/i,
      'winget OpenJS.NodeJS.LTS 預設裝在這個路徑；vin-windows-test 真實 case'
    );
  });

  it('fallback 試 %ProgramFiles%\\nodejs（環境變數版本，相容非 C: 系統碟）', () => {
    assert.match(
      content,
      /%ProgramFiles%\\nodejs|%PROGRAMFILES%\\nodejs/i,
      '系統碟不是 C: 的 user 也要能找到'
    );
  });

  it('全部 fallback 都失敗時 echo 列出嘗試過的路徑（方便 user 自助 debug）', () => {
    // 錯誤訊息要兼具：not found 描述 + 實際試過的路徑（多 echo 句）
    assert.match(content, /not found/i, '錯誤訊息要說 not found');
    assert.match(content, /Program Files\\nodejs/i, '錯誤訊息要列出 Program Files\\nodejs 路徑');
  });
});

describe('install.ps1 — 持久化 node 安裝路徑到 User PATH (v1.17.77)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');

  it('裝完 node 後檢查 User PATH 是否含 nodejs 目錄，不含則寫入', () => {
    // 必須呼叫 SetEnvironmentVariable("Path", ..., "User") 才能持久化
    assert.match(
      content,
      /SetEnvironmentVariable\(["']Path["']\s*,[^,]+,\s*["']User["']\)/,
      '必須用 User scope SetEnvironmentVariable 持久化，否則新 terminal 又找不到'
    );
  });
});
