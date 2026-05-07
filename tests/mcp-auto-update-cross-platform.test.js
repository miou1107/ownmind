/**
 * Reproduction tests：MCP auto-update 在 Windows 完全 silent fail
 *
 * 背景（2026-05-07 從工作紀錄分析發現）：
 *   Eric (LAPTOP-G95HIQ3V) 卡 v1.17.17、Adam 卡 v1.17.16
 *   兩人 4/21 後完全沒有 update_check / update_failed event
 *   原因：mcp/index.js 用 process.env.HOME 在 Windows 是 undefined，
 *   OWNMIND_DIR 變成相對路徑 '.ownmind' → fs.existsSync('.ownmind/.git')
 *   永遠 false → 整個 auto-update silent skip 沒有任何 log。
 *
 * 修法兩層：
 *   1. 用 os.homedir()（跨平台 — Windows 自動讀 USERPROFILE）
 *   2. 把 exec(bashScript) 改成 Node-native execFile 呼叫 git/npm，
 *      Unix 跑 update.sh、Windows 跑 update.ps1
 *   3. 條件不成立時必須 logEvent('update_skipped', {reason})，不能 silent skip
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpSource = readFileSync(join(__dirname, '..', 'mcp', 'index.js'), 'utf8');
const repoRoot = join(__dirname, '..');

test('mcp/index.js: OWNMIND_DIR 必須用 os.homedir()，不能用 process.env.HOME', () => {
  // 修前：path.join(process.env.HOME || '', '.ownmind')
  // 修後：path.join(os.homedir(), '.ownmind')
  assert.match(
    mcpSource,
    /OWNMIND_DIR\s*=\s*path\.join\(\s*os\.homedir\(\)\s*,\s*['"]\.ownmind['"]\s*\)/,
    'OWNMIND_DIR 必須走 os.homedir()，否則 Windows 拿不到 USERPROFILE → 路徑相對化 → silent skip'
  );
  assert.doesNotMatch(
    mcpSource,
    /OWNMIND_DIR[^\n]*process\.env\.HOME/,
    'OWNMIND_DIR 不可再用 process.env.HOME（Windows undefined）'
  );
});

test('mcp/index.js: import os module', () => {
  assert.match(
    mcpSource,
    /import\s+os\s+from\s+['"]os['"]|from\s+['"]os['"]\s+import/,
    'mcp/index.js 必須 import os 模組才能用 os.homedir()'
  );
});

test('mcp/index.js: 條件不成立時必須 logEvent(update_skipped) 而非 silent skip', () => {
  // 修前：條件不過直接 fall through 出 try block，沒任何 log
  // 修後：每個 skip path 寫 logEvent('update_skipped', { reason: '...' })
  assert.match(
    mcpSource,
    /logEvent\(['"]update_skipped['"]/,
    '必須加 update_skipped event，否則 user 卡舊版我們無從觀測'
  );
});

test('mcp/index.js: skip reasons 必須涵蓋三種情境', () => {
  // 三種 skip 情境：
  //   - marker_today: 今天已檢查過
  //   - no_git_dir: ~/.ownmind/.git 不存在（tarball 安裝、Windows 路徑錯）
  //   - lock_held: 另一個 process 正在更新
  for (const reason of ['marker_today', 'no_git_dir', 'lock_held']) {
    assert.ok(
      mcpSource.includes(`'${reason}'`) || mcpSource.includes(`"${reason}"`),
      `update_skipped reason 必須包含 '${reason}'`
    );
  }
});

test('mcp/index.js: 不再用 exec(bashScript) — 改用跨平台 execFile', () => {
  // 修前：exec(`touch ... cd ... bash ...`)（bash 語法在 Windows cmd 整段失敗）
  // 修後：execFile('git', [...], { cwd: OWNMIND_DIR }) 等
  // 至少不能有 bash heredoc 樣的 inline shell script 在 exec 裡
  assert.doesNotMatch(
    mcpSource,
    /exec\(`[\s\S]*?touch[\s\S]*?cd ~\/\.ownmind/,
    'exec(`touch ... cd ~/.ownmind ...`) 樣式必須移除（Windows cmd 不認）'
  );
});

test('mcp/index.js: Windows 平台用 npm.cmd（execFile 才找得到）', () => {
  // Node 的 execFile 在 Windows 直接呼叫 'npm' 會失敗（npm 是 npm.cmd）
  assert.match(
    mcpSource,
    /process\.platform\s*===?\s*['"]win32['"][\s\S]{0,200}npm\.cmd|npm\.cmd[\s\S]{0,200}process\.platform/,
    '需偵測 Windows 並用 npm.cmd，否則 npm install 在 Windows 會 ENOENT'
  );
});

test('scripts/update.ps1 必須存在（Windows 對等版）', () => {
  const ps1Path = join(repoRoot, 'scripts', 'update.ps1');
  assert.ok(
    existsSync(ps1Path),
    'scripts/update.ps1 必須存在；Windows MCP auto-update 結尾要呼叫它做 skill/hook 同步'
  );
});

test('scripts/update.ps1 必須同步 Claude Code skills 目錄', () => {
  const ps1Path = join(repoRoot, 'scripts', 'update.ps1');
  if (!existsSync(ps1Path)) return; // 上一個 test 會抓
  const content = readFileSync(ps1Path, 'utf8');
  // PS1 用 Join-Path 動態組路徑：".claude" + "skills\ownmind-memory\SKILL.md"
  // 同時必須提到 ownmind-memory 和 ownmind-upgrade skill
  assert.match(content, /\.claude/, 'update.ps1 必須引用 .claude 目錄');
  assert.match(content, /skills/i, 'update.ps1 必須處理 skills 同步');
  assert.match(content, /ownmind-memory/, 'update.ps1 必須複製 ownmind-memory skill');
  assert.match(content, /ownmind-upgrade/, 'update.ps1 必須複製 ownmind-upgrade skill');
  assert.match(content, /SessionStart|PreToolUse/,
    'update.ps1 必須注入 settings.json hooks（對應 update.sh 的 3. 段）');
});
