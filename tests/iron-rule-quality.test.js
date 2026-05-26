import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { lintIronRule } from '../src/utils/iron-rule-quality.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.94 — iron rule quality lint (program-logic gate, IR-027 landing)
 *
 * Why it exists:
 *   Core insight from Vin — once an iron rule is saved into OwnMind, future
 *   AI sessions reading it must (1) know when to trigger it, (2) know what
 *   the rule actually is. Otherwise the rule is window dressing.
 *   We can't rely on the AI to write clearly on its own; the server must
 *   lint and reject sloppy rules at write time.
 *
 * Design:
 *   - lintIronRule(rule) is a pure function: input {title, content, tags},
 *     output {ok, errors}.
 *   - Called by the server when POST/PUT memory type=iron_rule lands; 400
 *     on failure.
 *   - Applies to every client and every rule (no exceptions for legacy).
 */

describe('v1.17.94 — lintIronRule accepts a valid rule', () => {
  const goodRule = {
    title: '修報表加查詢條件讓數字歸 0 前、先檢查資料是不是還在',
    content: `## 什麼時候適用這條（觸發情境）
你正在修「漏觀測 / 異常筆數」類功能、想讓報表上的數字變小或歸零。

## 規則
不要加查詢條件把資料藏起來讓報表數字歸零。那是在藏、不是在修。

## 自我檢查
修完之後、本來顯示的資料還在資料庫嗎？還在 = 在藏 = 停下重新想。

字數要夠長、超過一百字才有意義、不能太短資訊不足。`,
    tags: ['trigger:edit', 'trigger:fix'],
  };

  it('valid rule returns ok=true and errors=[]', () => {
    const r = lintIronRule(goodRule);
    assert.equal(r.ok, true, `should not fail, errors: ${JSON.stringify(r.errors)}`);
    assert.deepEqual(r.errors, []);
  });
});

describe('v1.17.94 — trigger tag check', () => {
  it('missing trigger:xxx tag → fail', () => {
    const r = lintIronRule({
      title: '修報表前先檢查資料還在不在',
      content: '## 什麼時候適用\n修報表時\n## 規則\n不要加查詢條件藏資料。' + '字'.repeat(100),
      tags: ['some-tag', 'another-tag'],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('|'), /trigger/, 'error message should mention trigger');
  });

  it('no tags (undefined / null / empty array) → fail', () => {
    for (const tags of [undefined, null, []]) {
      const r = lintIronRule({
        title: '測試標題不要太短',
        content: '## 什麼時候適用\n測試時\n## 規則\n要遵守。' + '字'.repeat(100),
        tags,
      });
      assert.equal(r.ok, false, `tags=${JSON.stringify(tags)} should fail`);
    }
  });

  it('at least one trigger:xxx → passes this check', () => {
    const r = lintIronRule({
      title: '測試標題寫得夠長一點才會過',
      content: '## 什麼時候適用\n測試時\n## 規則\n要遵守。' + '字'.repeat(100),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, true, `should not fail on trigger, errors: ${JSON.stringify(r.errors)}`);
  });
});

describe('v1.17.94 — applicability section check', () => {
  it('content lacks "什麼時候適用 / 觸發 / 情境" section → fail', () => {
    const r = lintIronRule({
      title: '只有規則沒有適用情境',
      content: '這條規則要遵守。' + '字'.repeat(200),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('|'), /適用|觸發|情境|何時/,
      'error message should mention missing applicability section');
  });

  it('has "什麼時候適用" section → passes this check', () => {
    const r = lintIronRule({
      title: '有適用情境的鐵律寫得清楚一點',
      content: '## 什麼時候適用\n寫程式碼的時候\n## 規則\n要小心。' + '字'.repeat(100),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, true);
  });

  it('"觸發情境" also counts → pass', () => {
    const r = lintIronRule({
      title: '用觸發情境寫的鐵律也算通過',
      content: '## 觸發情境\n你在 commit 時\n## 規則\n禁止 force push。' + '字'.repeat(100),
      tags: ['trigger:commit'],
    });
    assert.equal(r.ok, true);
  });
});

describe('v1.17.94 — rule section check (do / dont actions)', () => {
  it('content lacks "規則 / 該做 / 不該做 / 禁止 / 必須" → fail', () => {
    const r = lintIronRule({
      title: '只有背景沒寫動作',
      content: '## 什麼時候適用\n寫程式時\n## 背景\n過去發生過一些事。' + '字'.repeat(150),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('|'), /規則|該做|不該做|禁止|必須/,
      'error message should mention missing action description');
  });

  it('has "規則" section → pass', () => {
    const r = lintIronRule({
      title: '有完整段落的鐵律寫得清楚一點',
      content: '## 什麼時候適用\n寫程式時\n## 規則\n不該偷懶。' + '字'.repeat(100),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, true);
  });
});

describe('v1.17.94 — forbid context-dependent phrases (future AI cannot understand)', () => {
  const forbidPhrases = ['上次', '之前那個', '剛剛', '這次 session', '這次對話'];

  for (const phrase of forbidPhrases) {
    it(`content contains "${phrase}" → fail`, () => {
      const r = lintIronRule({
        title: '測試標題夠長',
        content: `## 什麼時候適用\n寫程式時\n## 規則\n不要做 ${phrase} 提到的那種事。` + '字'.repeat(100),
        tags: ['trigger:edit'],
      });
      assert.equal(r.ok, false, `phrase="${phrase}" should fail`);
      assert.match(r.errors.join('|'), /context|脈絡|看不懂|依賴/,
        'error message should mention context-dependency problem');
    });
  }

  it('no such phrases → passes this check', () => {
    const r = lintIronRule({
      title: '不依賴 context 的鐵律',
      content: '## 什麼時候適用\n寫程式時\n## 規則\n禁止做不對的事。' + '字'.repeat(100),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, true);
  });
});

describe('v1.18.1 — iron-rule lint no longer enforces IR-037 mixed-language check (design D fix)', () => {
  // v1.17.94 originally ran IR-037 over rule content, but IR-037 is meant for
  // "AI replies"; the reply-lint Stop hook already covers that. Iron rules
  // themselves are "technical notes" and naturally contain technical terms.
  // The v1.18.1 audit of 35 prod rules showed 26 failing (74%), proving the
  // check was applied to the wrong scope.
  //
  // After removal: reasonable rules containing docker / openspec / Adam /
  // Eric (technical terms / names) are no longer rejected.
  it('lots of English words in a row (reasonable tech note) → pass (v1.18.1 no longer rejects)', () => {
    const r = lintIronRule({
      title: '混雜的鐵律',
      content: '## 什麼時候適用\nyou are coding the system component for example when refactoring the workflow\n## 規則\nyou should not just hide data behind filter conditions instead change the actual logic.' + 'a'.repeat(100),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, true,
      `v1.18.1: rule lint no longer runs IR-037 on content; reasonable mixed content should pass, errors: ${JSON.stringify(r.errors)}`);
  });

  it('rule containing docker / openspec / Adam / Eric tech terms → pass', () => {
    const r = lintIronRule({
      title: 'OwnMind 部署流程',
      content: '## 什麼時候適用\n部署到 prod\n## 規則\n必須用 docker compose build --no-cache、不能用 docker build。Adam / Eric 在 Windows 上跑要先檢查 openspec init 是否成功、走 propose → apply → archive 流程。' + '字'.repeat(50),
      tags: ['trigger:deploy'],
    });
    assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  });

  it('whitelisted tech terms (SQL / API / IR-XXX / OwnMind) do not count as mixed', () => {
    const r = lintIronRule({
      title: '只用白名單技術詞的鐵律',
      content: '## 什麼時候適用\n寫 SQL 改 API 動到 OwnMind 的時候\n## 規則\n要遵守 IR-027、不能把 WHERE 條件當作藏資料的手段。' + '字'.repeat(100),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, true, `whitelisted terms should not trigger mixed-language, errors: ${JSON.stringify(r.errors)}`);
  });
});

describe('v1.17.94 — length check', () => {
  it('content < 100 chars → fail (info insufficient)', () => {
    const r = lintIronRule({
      title: '太短的鐵律',
      content: '## 什麼時候適用\n寫程式\n## 規則\n要小心',
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('|'), /太短|資訊不足|字數/);
  });

  it('content > 3000 chars → fail (points unclear)', () => {
    const r = lintIronRule({
      title: '太長的鐵律',
      content: '## 什麼時候適用\n寫程式時\n## 規則\n要小心\n' + '字'.repeat(3500),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('|'), /太長|要點不明|字數/);
  });
});

describe('v1.17.94 — title check', () => {
  it('title < 10 chars → fail', () => {
    const r = lintIronRule({
      title: '太短',
      content: '## 什麼時候適用\n寫程式時\n## 規則\n要小心。' + '字'.repeat(100),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('|'), /title|標題/);
  });

  it('title > 100 chars → fail', () => {
    const r = lintIronRule({
      title: '這個鐵律的標題很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長',
      content: '## 什麼時候適用\n寫程式時\n## 規則\n要小心。' + '字'.repeat(100),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('|'), /title|標題/);
  });
});

describe('v1.17.94 — memory.js integration: iron_rule POST/PUT wires up lint', () => {
  // Static assertion; does not exercise the actual endpoint.
  const memorySrc = fs.readFileSync(path.join(repoRoot, 'src/routes/memory.js'), 'utf8');

  it('memory.js must import lintIronRule', () => {
    assert.match(memorySrc, /import\s*\{\s*lintIronRule\s*\}\s*from\s*['"]\.\.\/utils\/iron-rule-quality\.js['"]/,
      'memory.js must import lintIronRule');
  });

  it('POST / for type=iron_rule must call lintIronRule', () => {
    const m = memorySrc.match(/router\.post\('\/'[\s\S]+?(?=\nrouter\.|\nexport)/);
    assert.ok(m, 'POST / handler not found');
    assert.match(m[0], /lintIronRule\s*\(/,
      'POST / must call lintIronRule before writing an iron_rule');
  });

  it('PUT /:id for iron_rule update must also call lintIronRule', () => {
    const m = memorySrc.match(/router\.put\('\/:id'[\s\S]+?(?=\nrouter\.|\nexport)/);
    assert.ok(m, 'PUT /:id handler not found');
    assert.match(m[0], /lintIronRule\s*\(/,
      'PUT /:id must call lintIronRule before updating an iron_rule');
  });
});

describe('v1.17.94 — Dogfood reviewer Minor 8: v1.17.94 enforcement core rules must pass their own lint', () => {
  // Reviewer point: if v1.17.94 wants to enforce "iron-rule quality" using
  // IR-027 + IR-006 as reference rules, those rules must themselves pass the
  // lint — otherwise the design is internally inconsistent.
  it('IR-027 "reminders are ineffective; logic is what works" passes lint', () => {
    const ir027 = {
      title: '提醒無效，邏輯才有效 — 產品設計要用程式卡控',
      content: `## 規則
設計功能時，如果目標是「防止犯錯」，不要只加文字提醒。要問：
- 能不能用程式邏輯自動檢查？
- 能不能在行動當下驗證條件？
- 能不能讓系統自動偵測違反並回報？

文字提醒是最後手段，不是第一選擇。

## 適用範圍
所有產品設計、防呆機制、稽核流程。`,
      tags: ['trigger:edit', 'product-design', 'ownmind'],
    };
    const r = lintIronRule(ir027);
    assert.equal(r.ok, true, `IR-027 should pass, errors: ${JSON.stringify(r.errors)}`);
  });

  it('IR-006 "any new knowledge must propagate across all layers" passes lint', () => {
    const ir006 = {
      title: '學到東西必須全層同步更新',
      content: `## 規則
學到新東西時、必須一次性更新所有相關層級（Skill、Adapter、Spec、Memory、Project status）、不可只改一處就停。

## 適用情境
所有知識更新、踩坑後的教訓、新技術導入。`,
      tags: ['trigger:edit', 'trigger:commit'],
    };
    const r = lintIronRule(ir006);
    assert.equal(r.ok, true, `IR-006 should pass, errors: ${JSON.stringify(r.errors)}`);
  });
});

describe('v1.17.94 — Dogfood: re-running lint on IR-039 should pass', () => {
  // Dogfooding: the v1.17.94 lint design was driven by IR-039 needing
  // three rewrites before it landed. If IR-039 cannot pass, the lint
  // rules are too strict; if it passes, the rules are at acceptable.
  it('IR-039 content under lint should pass', () => {
    const ir039 = {
      title: '修報表/儀表板加查詢條件讓數字歸 0 前、先檢查資料是不是還在',
      content: `## 什麼時候適用這條（觸發情境）
你正在修「漏觀測 / 異常筆數 / 待處理列表 / 踩坑紀錄 / 儀表板數字」類功能、想讓報表上的數字變小或歸零。

## 規則（一句話）
不要加查詢條件（WHERE / filter / 時間條件 / 版本條件 / 任何 cutoff）把資料藏起來讓報表數字歸零。那是在藏、不是在修。

## 立刻自我檢查（兩個問題）
做修法之前停下來問自己：

問題 1：修完之後、本來顯示在報表上的那些資料還在資料庫嗎？
- 還在、只是查詢層看不到 → 你在藏 → 停下、重新想
- 沒了（被補完、被修正、真的被刪）→ 你在修 → 繼續

問題 2：你正在加的東西是哪一類？
- WHERE 加時間條件、版本條件、cutoff、排除條件 → 在藏 → 停下
- 改判斷邏輯本身、補資料、修錯算的公式 → 在修 → 繼續`,
      tags: ['trigger:edit', 'trigger:debug', 'trigger:fix', 'trigger:bug',
             'trigger:dashboard', 'trigger:report', 'trigger:metrics',
             'trigger:pitfalls', 'trigger:sql_filter', 'trigger:hide_data'],
    };
    const r = lintIronRule(ir039);
    assert.equal(r.ok, true, `IR-039 should not be rejected by lint, errors: ${JSON.stringify(r.errors)}`);
  });
});
