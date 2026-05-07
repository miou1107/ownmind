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

test('P3: mcp/index.js 必須對 update_applied / update_clean 兩種情境分流（不再依賴 shell marker）', () => {
  // v1.17.22 後改用 Node-native execFile，不再用 shell __OM_APPLIED__ / __OM_CLEAN__ marker
  // 但 update_applied vs update_clean 的語意分流仍是 P3 的核心：
  //   - 真有拉到新 commit + 全步驟成功 → update_applied
  //   - 沒新 commit（git log HEAD..origin/main 空）→ update_clean
  assert.match(
    mcpSource,
    /logEvent\(['"]update_applied['"]/,
    'mcp/index.js 必須在拉到新 commit 且各步驟成功後寫 update_applied'
  );
  assert.match(
    mcpSource,
    /logEvent\(['"]update_clean['"]/,
    'mcp/index.js 必須在沒新版時寫 update_clean，不能默默走完'
  );
});

test('P3: mcp/index.js 各關鍵 step 失敗必須顯式寫 update_failed（不再被 silent 吞）', () => {
  // v1.17.22 重構為 Node-native after Eric/Adam Windows silent-skip incident
  // 每個 step（fetch / log / pull / npm / update_sh）失敗都會走 fail() helper
  // 寫 update_failed 並帶 step 名稱
  assert.match(
    mcpSource,
    /logEvent\(['"]update_failed['"][^)]*step/,
    'update_failed event 必須帶 step 欄位區分失敗位置'
  );
  // 必須涵蓋所有關鍵 step
  for (const step of ['fetch', 'pull', 'npm', 'update_sh']) {
    assert.ok(
      mcpSource.includes(`'${step}'`) || mcpSource.includes(`"${step}"`),
      `step="${step}" 必須在 update_failed 路徑出現`
    );
  }
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

test('P3-lock: mcp/index.js touch LOCK_FILE 失敗必須寫 update_failed step=lock（v1.17.22 改 Node-native）', () => {
  // v1.17.19 原本是 shell `touch "${LOCK_FILE}" || echo __OM_LOCK_FAIL__`
  // v1.17.22 重構為 Node-native：fs.writeFileSync 包 try/catch，失敗走 update_failed step=lock
  // 確認 fs.writeFileSync(LOCK_FILE...) 在 try/catch 內，且 catch 走 update_failed step=lock
  assert.match(
    mcpSource,
    /fs\.writeFileSync\(LOCK_FILE[\s\S]{0,200}step:\s*['"]lock['"]/,
    'mcp/index.js 必須對 fs.writeFileSync(LOCK_FILE) 失敗寫 update_failed step=lock'
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
