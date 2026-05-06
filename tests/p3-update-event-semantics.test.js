/**
 * P3: update_ok event semantics 測試
 *
 * 背景（Adam case，2026-04-26）：Adam 的 client 是 1.17.10，dashboard 看到他
 * 4/26 有 `update_check + update_ok` 兩個 event，但實際 client 還是 1.17.10。
 *
 * Root cause: mcp/index.js 的 background update exec callback 在 shell exit 0
 * 時統一寫 `update_ok`，但 shell 在以下情境都會 exit 0：
 *   - UPDATES="" 沒新 commit 可拉（沒進 if，但 echo marker 仍 exit 0）
 *   - git pull 失敗被 `2>/dev/null` 吞 + `||` fallback
 *   - npm install / update.sh silent fail
 *
 * 結果：`update_ok` 字面意思「升級成功」≠ 實際語意「shell 沒爆」。
 *
 * 修法：
 *   - 把 `update_ok` 拆成 `update_applied`（真有拉到新 commit）和 `update_clean`（沒新版）
 *   - shell 內每個關鍵 step（git pull / npm install / update.sh）顯式 trap exit code
 *   - dashboard label mapping 同步更新
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpSource = readFileSync(join(__dirname, '..', 'mcp', 'index.js'), 'utf8');
const hookSource = readFileSync(join(__dirname, '..', 'hooks', 'ownmind-session-start.sh'), 'utf8');
const dashboardHtml = readFileSync(join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');

test('P3: mcp/index.js 不再寫死 update_ok（要分 update_applied / update_clean）', () => {
  // 修前：` logEvent('update_ok', { source: 'mcp' });` 出現在 callback else 分支
  // 修後：應該完全沒這個字串了
  assert.equal(
    mcpSource.includes("logEvent('update_ok'"),
    false,
    'update_ok 應該被淘汰，改用 update_applied (拉到新 commit) 或 update_clean (沒新版)'
  );
});

test('P3: mcp/index.js 必須寫 update_applied 給「真有拉到新 commit」的 case', () => {
  assert.match(
    mcpSource,
    /logEvent\(['"]update_applied['"]/,
    'mcp/index.js 必須有 logEvent("update_applied", ...)，對應 dashboard 的「已更新」label'
  );
});

test('P3: mcp/index.js 必須寫 update_clean 給「沒新版可拉」的 case', () => {
  assert.match(
    mcpSource,
    /logEvent\(['"]update_clean['"]/,
    'mcp/index.js 必須有 logEvent("update_clean", ...)，對應 dashboard 的「無新版」label'
  );
});

test('P3: shell pipeline 必須有 __OM_APPLIED__ 跟 __OM_CLEAN__ marker 才能讓 callback 可靠分支', () => {
  assert.ok(
    mcpSource.includes('__OM_APPLIED__'),
    'shell 必須在「git pull 拉到新 commit + npm install + update.sh 都成功」時 echo __OM_APPLIED__'
  );
  assert.ok(
    mcpSource.includes('__OM_CLEAN__'),
    'shell 必須在「UPDATES 為空」時 echo __OM_CLEAN__，而不是默默走完'
  );
});

test('P3: shell 關鍵 step 必須顯式 trap exit code（git pull / npm install / update.sh 不能再被 silent 吞）', () => {
  // 修前 shell 用 `git pull -q 2>/dev/null` + `||` fallback，silent 吞失敗。
  // 修後每個關鍵 step 必須要嘛 echo 失敗 marker、要嘛 exit non-zero。
  // 我們檢查至少有一個明確 fail marker 來代表這個防禦縱深存在。
  const hasFailMarker =
    mcpSource.includes('__OM_PULL_FAIL__') ||
    mcpSource.includes('__OM_NPM_FAIL__') ||
    mcpSource.includes('__OM_UPDATE_FAIL__');
  assert.ok(
    hasFailMarker,
    'shell 內必須對 git pull / npm install / update.sh 任一加顯式失敗 marker 或 exit code，避免 silent 失敗仍寫 update_applied'
  );
});

test('P3: dashboard label 必須含 update_clean（修前只有 update_check + update_applied）', () => {
  // index.html 已有 'update_check: 檢查更新' 和 'update_applied: 已更新'
  // 必須再加 'update_clean: 無新版' 否則新 event 在 dashboard 顯示英文 raw key
  assert.match(
    dashboardHtml,
    /update_clean\s*:\s*['"][^'"]+['"]/,
    'src/public/index.html 的 ZH 對應表必須加 update_clean 中文 label'
  );
});

test('P3: dashboard label 必須含 update_failed（修前完全沒這個 entry）', () => {
  assert.match(
    dashboardHtml,
    /update_failed\s*:\s*['"][^'"]+['"]/,
    'src/public/index.html 的 ZH 對應表必須加 update_failed 中文 label，不然 user 看到 raw key'
  );
});

// ────────────────────────────────────────────────────────────
// hooks/ownmind-session-start.sh 同款修正（review 抓到的對偶 bug）
// 修前 hook 跟 mcp/index.js 共用同款 silent-fail pattern，
// 但 hook 觸發頻率（每個 SessionStart）>> MCP 啟動頻率，假陽性 update_applied
// 影響更大。必須對齊修法，否則 P3 只解了一半。
// ────────────────────────────────────────────────────────────

test('P3: hook 不能在 git pull 後直接無條件寫 update_applied（要先檢查每步的 exit code）', () => {
  // 修前 pattern：
  //   git pull -q --rebase 2>/dev/null || git pull -q 2>/dev/null
  //   cd "$OWNMIND_DIR/mcp" && npm install -q 2>/dev/null
  //   bash ... update.sh >/dev/null 2>&1
  //   log_event "update_applied"   ← 無條件
  // 修後：每步用 if !; then log_event "update_failed"; exit; fi 包起來
  // 防退化：hook 不能再含「git pull ... || git pull ...」後面馬上接 log_event "update_applied"
  // 的 pattern（中間沒檢查 exit code）。改用 grep 「if ! 」次數判斷
  const ifNotCount = (hookSource.match(/if ! /g) || []).length;
  assert.ok(
    ifNotCount >= 4,
    `hook 必須對 fetch/pull/npm/update.sh 任意 step 顯式檢查 exit code（if ! ...），目前只有 ${ifNotCount} 個 if !`
  );
});

test('P3: hook 必須能寫 update_clean（沒新版可拉的情境）', () => {
  assert.match(
    hookSource,
    /log_event\s+["']update_clean["']/,
    'hook 在 UPDATES 為空時必須 log update_clean，不能默默走完'
  );
});

test('P3: hook 必須能寫 update_failed（任一 step 出錯）', () => {
  assert.match(
    hookSource,
    /log_event\s+["']update_failed["']/,
    'hook 在 fetch/pull/npm/update.sh 任一失敗時必須 log update_failed，不能 silent 吞'
  );
});

// ────────────────────────────────────────────────────────────
// v1.17.19 補修（project_281 backlog item C）：
// LOCK_FILE touch 失敗（disk full / readonly FS）原本沒偵測，
// 後續會在沒 lock 保護下繼續跑 → race condition 風險。
// 對齊 P3「每步顯式 trap」原則，把 lock 也納入失敗 marker。
// ────────────────────────────────────────────────────────────

test('P3-lock: mcp/index.js shell 必須對 touch LOCK_FILE 失敗顯式 echo marker', () => {
  // 修前：`touch "${LOCK_FILE}"` 沒接 ||
  // 修後：`touch "${LOCK_FILE}" || { echo "__OM_LOCK_FAIL__"; exit 9; }`
  assert.match(
    mcpSource,
    /touch\s+"\$\{LOCK_FILE\}"\s*\|\|\s*\{\s*echo\s+"__OM_LOCK_FAIL__"/,
    'shell 內 touch LOCK_FILE 必須對失敗 echo __OM_LOCK_FAIL__ marker，不能默默繼續跑'
  );
});

test('P3-lock: mcp/index.js callback failMarkers 必須包含 __OM_LOCK_FAIL__', () => {
  // 確保 callback 解 stdout 時能識別 lock 失敗、寫 update_failed step=lock
  assert.ok(
    mcpSource.includes('__OM_LOCK_FAIL__'),
    'failMarkers 陣列 / callback 解析必須認得 __OM_LOCK_FAIL__，否則 lock 失敗會被歸成 unknown step'
  );
});

test('P3-lock: hooks/ownmind-session-start.sh 必須對 touch LOCK_FILE 失敗 log update_failed step=lock', () => {
  // 修前：`touch "$LOCK_FILE"` 沒接 ||
  // 修後：`touch "$LOCK_FILE" || { log_event "update_failed" "step" "lock"; exit 0; }`
  assert.match(
    hookSource,
    /touch\s+"\$LOCK_FILE"\s*\|\|\s*\{[^}]*log_event[^}]*update_failed[^}]*lock/,
    'hook 內 touch LOCK_FILE 必須對失敗 log update_failed step=lock，不能默默繼續跑'
  );
});
