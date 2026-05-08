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

// v1.17.23 補修（Codex review 抓到的 4 個問題）

test('v1.17.23 update.ps1: Node script 用 argv[2]/argv[3] 而非 argv[1]/argv[2]', () => {
  // v1.17.22 bug：node $tmpScript $arg1 $arg2 時 argv[1] 是 .js 檔路徑
  // 不是 $arg1，會嘗試 JSON.parse 自己 → settings 注入整段失效
  const ps1Path = join(repoRoot, 'scripts', 'update.ps1');
  if (!existsSync(ps1Path)) return;
  const content = readFileSync(ps1Path, 'utf8');
  // 應該用 argv[2]（settings path）和 argv[3]（noSessionHook flag）
  assert.match(
    content,
    /process\.argv\[2\]/,
    'Node 腳本接 settings path 必須用 process.argv[2]（argv[1] 是 .js 檔本身）'
  );
  assert.doesNotMatch(
    content,
    /settingsPath\s*=\s*process\.argv\[1\]/,
    'argv[1] 是 .js 檔路徑，不能拿來當 settings path'
  );
});

test('v1.17.23 mcp/index.js: lock acquire 必須 atomic（openSync wx）', () => {
  // v1.17.22 用 existsSync + writeFileSync，TOCTOU race：兩個 MCP 同時通過 existsSync
  // 修法：fs.openSync(LOCK_FILE, 'wx') — exclusive create，已存在會 EEXIST
  assert.match(
    mcpSource,
    /fs\.openSync\(LOCK_FILE,\s*['"]wx['"]\)/,
    'lock acquire 必須用 openSync wx flag 才 atomic（避免並發 race）'
  );
});

test('v1.17.23 update.ps1: 必須有 Gemini / Copilot / Cursor hooks 注入', () => {
  // v1.17.22 update.ps1 漏了 update.sh 的 4./5./6. 段（Gemini / GitHub Copilot / Cursor）
  const ps1Path = join(repoRoot, 'scripts', 'update.ps1');
  if (!existsSync(ps1Path)) return;
  const content = readFileSync(ps1Path, 'utf8');
  for (const tool of ['.gemini', '.github', '.cursor']) {
    assert.ok(
      content.includes(tool),
      `update.ps1 必須注入 ${tool} hook（對應 update.sh 的 4./5./6. 段）`
    );
  }
});

test('v1.17.23 mcp/index.js: 用 git pull --autostash（避免 stash 後沒 pop 吞 user 變更）', () => {
  // v1.17.22 git stash -q 後 pull，但沒 stash pop → user 未提交變更會消失
  // 修法：git pull --rebase --autostash 一次搞定（git 2.6+）
  assert.match(
    mcpSource,
    /['"]--autostash['"]/,
    'git pull 必須帶 --autostash flag，避免 stash 後沒 pop 吞掉 user 變更'
  );
});

test('v1.17.65 mcp/index.js: autostash fallback 不能再帶 --autostash（不然兩條路都同樣失敗）', () => {
  // v1.17.23 寫了 fallback 處理 git < 2.6 沒 --autostash 支援的舊版，但 fallback
  // 那條也帶 --autostash → 主路徑失敗的 root cause 在 fallback 一定再失敗一次。
  // 修法：fallback 改 git pull -q --ff-only（不帶 --autostash、不帶 --rebase）。
  // user 工作樹有未提交變更時 ff-only pull 會明確拒絕並 logEvent step=pull，user 自己處理；
  // 不再做手動 stash → v1.17.22 已驗證手動 stash 沒 pop 會吞 user 變更。
  const idx = mcpSource.indexOf("'pull', '-q', '--rebase', '--autostash'");
  assert.ok(idx >= 0, '主路徑仍須是 git pull -q --rebase --autostash');
  // 從主路徑 catch block 開始 1500 字內找 fallback 的 execFile
  const slice = mcpSource.slice(idx, idx + 1500);
  const fallbackMatch = slice.match(/} catch[\s\S]+?execFile\([^)]*'git'[^)]*\[([^\]]+)\]/);
  assert.ok(fallbackMatch, '主路徑後須有 fallback execFile git 區塊');
  assert.ok(
    !fallbackMatch[1].includes('--autostash'),
    'autostash fallback 不可再帶 --autostash（v1.17.23 留下的死路徑），實際參數：' + fallbackMatch[1]
  );
});

test('v1.17.23 mcp/index.js: 外層 catch 必須 log update_failed step=outer', () => {
  // v1.17.22 runAutoUpdate().catch(() => {}) silent fail
  // 修法：catch (e) => logEvent('update_failed', { step: 'outer', error: ... })
  assert.match(
    mcpSource,
    /runAutoUpdate\(\)\.catch\([\s\S]{0,200}step:\s*['"]outer['"]/,
    '外層 catch 必須 logEvent update_failed step=outer，不能 silent 吞例外'
  );
});
