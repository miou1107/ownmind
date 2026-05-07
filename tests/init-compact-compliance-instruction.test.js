/**
 * Reproduction test：4/21 之後 iron_rule_compliance event 突然降為 0 的根因
 *
 * 背景（2026-05-07 診斷）：
 *   - MCP tool ownmind_report_compliance 寫入端正常
 *   - 但 SessionStart hook 用 ?compact=true 拉 init API
 *   - compact 把 INSTRUCTIONS_SOP 整段拿掉（src/routes/memory.js:653）
 *     → AI 在 compact response 裡看不到「必須呼叫 ownmind_report_compliance」這條指令
 *   - 隨時間推移 AI 漸漸不再主動呼叫，4/21 後完全停
 *
 * 修法：在 iron_rules_digest 末尾固定加上 compliance 指令，這樣 compact mode
 * 也送得到。digest 是合規回報的天然搭檔（鐵律觸發 → 必須回報），語意一致。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const memorySource = readFileSync(join(__dirname, '..', 'src', 'routes', 'memory.js'), 'utf8');

test('init route：iron_rules_digest 必須含 ownmind_report_compliance 指令（compact 也送）', () => {
  // 修前：compliance 指令只在 INSTRUCTIONS_SOP，被 !compact 阻擋
  // 修後：digest 末尾固定追加 compliance 指令
  assert.match(
    memorySource,
    /ironRulesDigestFinal[\s\S]*?ownmind_report_compliance/,
    'src/routes/memory.js 必須在組裝 ironRulesDigestFinal 時加入「呼叫 ownmind_report_compliance」字樣，否則 compact mode 拿不到指令'
  );
});

test('init route：compact mode 仍會 emit iron_rules_digest（不被砍）', () => {
  // 確認 digest 在 res.json 裡不被 compact 阻擋
  // 修前後都該過——這是 control test，防止未來 refactor 把 digest 搬到 compact 後面
  assert.match(
    memorySource,
    /iron_rules_digest:\s*ironRulesDigestFinal/,
    'res.json 必須直接送 iron_rules_digest（不能加 !compact 條件）'
  );
});

test('init route：compliance 指令必須提到 comply / skip / violate 三個 action', () => {
  // 確保指令完整、AI 不會只記住 comply 而忘了 skip / violate
  const digestSection = memorySource.match(
    /ironRulesDigestFinal[\s\S]{0,800}/
  )?.[0] || '';
  for (const action of ['comply', 'skip', 'violate']) {
    assert.ok(
      digestSection.includes(action),
      `digest 末段必須提到 action='${action}'，目前抓到的段落不含這個 keyword`
    );
  }
});
