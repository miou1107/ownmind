import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.87 — /api/me/pitfalls endpoint + me.js sensitive event 修法
 *
 * 背景：v1.17.86 之前個人 /me 頁面顯示 9 筆「漏觀測」警告。問題：
 *   1. 警告是系統 bug 或 AI 行為問題，不是個別 user 該緊張
 *   2. 跨 user 比對才看得出 pattern
 *   3. handoff_create 被列入 sensitive event 但 activity.js autoEmit 故意不觀測
 *      handoff（過度推論問題），兩端設計不一致導致 handoff 永遠進 unobserved 警告
 *
 * 修法（v1.17.87）：
 *   1. me.js sensitive event 拿掉 handoff_create（跟 activity.js 對齊）
 *   2. me.js 個人頁拿掉 compliance_unobserved / compliance_unverified / orphan_session
 *      三條警告
 *   3. 新 /api/me/pitfalls endpoint 跨 user 合併呈現、任何 user 可見
 *   4. memory.js save iron_rule + disable handler server 端寫 system_auto compliance
 *      log，補 7 筆漏觀測根因（autoEmit 邏輯沒接到 memory.js 路徑）
 */

describe('v1.17.87 — me.js sensitive event 拿掉 handoff_create', () => {
  const meSource = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');

  it('sensitive event CASE 不再包含 handoff_create', () => {
    // 找 complianceGapQ 那段 CASE
    const m = meSource.match(/WITH sensitive AS \(([\s\S]+?)\),\s*\n\s*classified/);
    assert.ok(m, '找不到 sensitive CTE');
    // 剝掉 SQL 行註解（-- ...）避免註解裡為了說明而出現的 handoff_create 誤判
    const sensCteCode = m[1].replace(/--[^\n]*/g, '');
    assert.doesNotMatch(sensCteCode, /handoff_create/,
      'me.js sensitive event 列表不該再包含 handoff_create（跟 activity.js autoEmit 設計選擇對齊）');
    // 仍然保留兩個 sensitive 事件
    assert.match(sensCteCode, /memory_disable/, '仍要保留 memory_disable');
    assert.match(sensCteCode, /memory_save.*type.*iron_rule/s, '仍要保留 memory_save iron_rule');
  });

  it('個人頁的 myAuditFindings 不再 push compliance_unobserved / unverified / orphan_session', () => {
    const findingsBlock = meSource.match(/const myAuditFindings = \[\];([\s\S]+?)\/\/ P3:/);
    assert.ok(findingsBlock, '找不到 myAuditFindings block');
    const block = findingsBlock[1];
    assert.doesNotMatch(block, /type:\s*['"]compliance_unobserved['"]/,
      '個人頁不再 push compliance_unobserved（搬到 /api/me/pitfalls）');
    assert.doesNotMatch(block, /type:\s*['"]compliance_unverified['"]/,
      '個人頁不再 push compliance_unverified');
    assert.doesNotMatch(block, /type:\s*['"]orphan_session['"]/,
      '個人頁不再 push orphan_session');
    // 仍保留三條非合規警告
    assert.match(block, /heartbeat_absent/, '保留 heartbeat 警告');
    assert.match(block, /source_inconsistent/, '保留 source 警告');
  });
});

describe('v1.17.87 — /api/me/pitfalls endpoint 結構', () => {
  const meSource = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');

  it('me.js 含 GET /pitfalls route', () => {
    assert.match(meSource, /router\.get\(['"]\/pitfalls['"]/,
      'me.js 必須註冊 GET /pitfalls route');
  });

  it('endpoint 跨 user JOIN（不限制 user_id = req.user.id）', () => {
    // 找 pitfalls route 內容
    const routeMatch = meSource.match(/router\.get\(['"]\/pitfalls['"][\s\S]+?(?=\nrouter\.|\nexport default)/);
    assert.ok(routeMatch, '找不到 pitfalls route');
    const route = routeMatch[0];
    // 要 JOIN users 拿 name
    assert.match(route, /JOIN users u ON u\.id = s\.user_id/,
      'pitfalls query 必須 JOIN users 拿 user name');
    // 不能寫 WHERE a.user_id = $1 限制單一 user（要跨 user）
    assert.ok(!/WHERE\s+a\.user_id\s*=\s*\$1/.test(route),
      'pitfalls 不該限制 user_id = $1（要跨 user）');
  });

  it('三個 section (unobserved / unverified / orphan_session) 都有 query', () => {
    const routeMatch = meSource.match(/router\.get\(['"]\/pitfalls['"][\s\S]+?(?=\nrouter\.|\nexport default)/);
    const route = routeMatch[0];
    assert.match(route, /unobservedQ/, '要有 unobserved query');
    assert.match(route, /unverifiedQ/, '要有 unverified query');
    assert.match(route, /orphanQ/, '要有 orphan_session query');
  });

  it('每筆 row 含四欄位（when / what / impact / fix_hint）', () => {
    const routeMatch = meSource.match(/router\.get\(['"]\/pitfalls['"][\s\S]+?(?=\nrouter\.|\nexport default)/);
    const route = routeMatch[0];
    for (const field of ['when:', 'what,', 'impact:', 'fix_hint:']) {
      assert.match(route, new RegExp(field.replace(/[:.]/g, '\\$&')),
        `formatter 必須帶 ${field} 欄位`);
    }
  });

  it('支援 window query param (7d / 30d / 90d / all)', () => {
    const routeMatch = meSource.match(/router\.get\(['"]\/pitfalls['"][\s\S]+?(?=\nrouter\.|\nexport default)/);
    const route = routeMatch[0];
    assert.match(route, /req\.query\.window/);
    assert.match(route, /['"]7d['"]/);
    assert.match(route, /['"]90d['"]/);
    assert.match(route, /['"]all['"]/);
  });
});

describe('v1.17.87 — memory.js save iron_rule + disable 寫 system_auto compliance', () => {
  const memSource = fs.readFileSync(path.join(repoRoot, 'src/routes/memory.js'), 'utf8');

  it('save handler 在 type === iron_rule 時 INSERT iron_rule_compliance', () => {
    // 找 POST / 那段
    const saveMatch = memSource.match(/router\.post\(['"]\/['"][\s\S]+?(?=\nrouter\.|\n\/\*\*)/);
    assert.ok(saveMatch, '找不到 save POST route');
    const route = saveMatch[0];
    assert.match(route,
      /if \(type === ['"]iron_rule['"]\)[\s\S]{0,600}INSERT INTO activity_logs[\s\S]{0,200}iron_rule_compliance[\s\S]{0,400}system_server_auto/,
      'save handler 在 type=iron_rule 時必須 INSERT activity_logs event=iron_rule_compliance source=system_server_auto');
  });

  it('disable handler 在 type === iron_rule 時 INSERT iron_rule_compliance', () => {
    const disableMatch = memSource.match(/router\.put\(['"]\/:id\/disable['"][\s\S]+?(?=\nrouter\.|\n\/\*\*)/);
    assert.ok(disableMatch, '找不到 disable PUT route');
    const route = disableMatch[0];
    assert.match(route,
      /if \(result\.rows\[0\]\.type === ['"]iron_rule['"]\)[\s\S]{0,600}INSERT INTO activity_logs[\s\S]{0,200}iron_rule_compliance[\s\S]{0,400}system_server_auto/,
      'disable handler 在 type=iron_rule 時必須 INSERT compliance log');
  });

  it('compliance log 帶 rule_code=IR-006（學到東西必須全層同步更新）', () => {
    // save + disable 兩條都用 IR-006
    assert.match(memSource, /rule_code:\s*['"]IR-006['"]/,
      'memory.js 必須帶 IR-006 rule_code');
  });

  it('compliance log action=observed_trigger（不是 comply）', () => {
    // system_auto 寫的是「觀測到觸發」、不是「AI 主動回報遵守」
    const matches = memSource.match(/action:\s*['"]observed_trigger['"]/g);
    assert.ok(matches && matches.length >= 2,
      '記憶體 save / disable handler 都應該 action=observed_trigger（至少 2 處）');
  });

  it('INSERT 失敗不擋主流程（try/catch）', () => {
    // 兩條 handler 都應該包 try/catch
    const tryBlocks = memSource.match(/try \{\s*await query\(\s*`INSERT INTO activity_logs[\s\S]{0,800}\} catch/g);
    assert.ok(tryBlocks && tryBlocks.length >= 2,
      'save + disable 兩條的 compliance INSERT 都要 try/catch 防 server 失敗擋主流程');
  });
});

describe('v1.17.87 — me.html 加「踩坑紀錄」tab', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'src/public/me/index.html'), 'utf8');

  it('tabs 列含 pitfalls 按鈕', () => {
    assert.match(html, /<button data-tab="pitfalls"[^>]*>🕳️ 踩坑紀錄<\/button>/);
  });

  it('tab-pitfalls 容器存在 + 三個 section', () => {
    assert.match(html, /<div id="tab-pitfalls"/);
    assert.match(html, /pitfalls-section-unobserved/);
    assert.match(html, /pitfalls-section-unverified/);
    assert.match(html, /pitfalls-section-orphan/);
  });

  it('time window 下拉選有 7d/30d/90d/all 四選項', () => {
    assert.match(html, /value="7d"/);
    assert.match(html, /value="30d"\s+selected/);
    assert.match(html, /value="90d"/);
    assert.match(html, /value="all"/);
  });

  it('loadPitfalls function 從 /api/me/pitfalls fetch', () => {
    assert.match(html, /async function loadPitfalls/);
    assert.match(html, /fetch\(`\/ownmind\/api\/me\/pitfalls\?window=/);
  });

  it('renderPitfalls 用 <details> + summary 做展開 UI', () => {
    assert.match(html, /<details/);
    assert.match(html, /<summary/);
    // 四欄位
    for (const label of ['何時：', '誰：', '發生情況：', '造成影響：', '建議修法：']) {
      assert.match(html, new RegExp(label),
        `展開內容必須含「${label}」欄位`);
    }
  });
});
