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
 * v1.17.94 — 鐵律品質檢查（程式邏輯卡控、IR-027 落地）
 *
 * 為什麼存在：
 *   Vin 提的核心 — 鐵律寫進 OwnMind 之後、未來新 session 的 AI 看到要能：
 *   (1) 知道什麼時候該觸發、(2) 知道規則是什麼。不然鐵律形同虛設。
 *   不能靠 AI 自覺寫得清楚、要靠 server 端 lint 卡住、寫得太爛就退回不讓存。
 *
 * 設計：
 *   - lintIronRule(rule) 純函式、輸入 {title, content, tags}、回 {ok, errors}
 *   - server 端 POST/PUT memory type=iron_rule 時呼叫、不過 400
 *   - 所有人都會被卡（不分 client、不分新舊鐵律）
 */

describe('v1.17.94 — lintIronRule 通過合格鐵律', () => {
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

  it('合格鐵律 ok=true、errors=[]', () => {
    const r = lintIronRule(goodRule);
    assert.equal(r.ok, true, `不該失敗、errors: ${JSON.stringify(r.errors)}`);
    assert.deepEqual(r.errors, []);
  });
});

describe('v1.17.94 — trigger tag 檢查', () => {
  it('缺 trigger:xxx tag → 失敗', () => {
    const r = lintIronRule({
      title: '修報表前先檢查資料還在不在',
      content: '## 什麼時候適用\n修報表時\n## 規則\n不要加查詢條件藏資料。' + '字'.repeat(100),
      tags: ['some-tag', 'another-tag'],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('|'), /trigger/, '錯誤訊息應提到 trigger');
  });

  it('沒 tags（undefined / null / 空陣列）→ 失敗', () => {
    for (const tags of [undefined, null, []]) {
      const r = lintIronRule({
        title: '測試標題不要太短',
        content: '## 什麼時候適用\n測試時\n## 規則\n要遵守。' + '字'.repeat(100),
        tags,
      });
      assert.equal(r.ok, false, `tags=${JSON.stringify(tags)} 應失敗`);
    }
  });

  it('有至少一個 trigger:xxx → 通過該項', () => {
    const r = lintIronRule({
      title: '測試標題寫得夠長一點才會過',
      content: '## 什麼時候適用\n測試時\n## 規則\n要遵守。' + '字'.repeat(100),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, true, `不該因 trigger 失敗、errors: ${JSON.stringify(r.errors)}`);
  });
});

describe('v1.17.94 — 適用情境段落檢查', () => {
  it('內容沒寫「什麼時候適用 / 觸發 / 情境」之類段落 → 失敗', () => {
    const r = lintIronRule({
      title: '只有規則沒有適用情境',
      content: '這條規則要遵守。' + '字'.repeat(200),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('|'), /適用|觸發|情境|何時/,
      '錯誤訊息應提到缺適用情境');
  });

  it('有「什麼時候適用」段落 → 通過該項', () => {
    const r = lintIronRule({
      title: '有適用情境的鐵律寫得清楚一點',
      content: '## 什麼時候適用\n寫程式碼的時候\n## 規則\n要小心。' + '字'.repeat(100),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, true);
  });

  it('用「觸發情境」也算 → 通過', () => {
    const r = lintIronRule({
      title: '用觸發情境寫的鐵律也算通過',
      content: '## 觸發情境\n你在 commit 時\n## 規則\n禁止 force push。' + '字'.repeat(100),
      tags: ['trigger:commit'],
    });
    assert.equal(r.ok, true);
  });
});

describe('v1.17.94 — 規則段落檢查（該做/不該做的動作）', () => {
  it('內容沒寫「規則 / 該做 / 不該做 / 禁止 / 必須」 → 失敗', () => {
    const r = lintIronRule({
      title: '只有背景沒寫動作',
      content: '## 什麼時候適用\n寫程式時\n## 背景\n過去發生過一些事。' + '字'.repeat(150),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('|'), /規則|該做|不該做|禁止|必須/,
      '錯誤訊息應提到缺動作描述');
  });

  it('有「規則」段落 → 通過', () => {
    const r = lintIronRule({
      title: '有完整段落的鐵律寫得清楚一點',
      content: '## 什麼時候適用\n寫程式時\n## 規則\n不該偷懶。' + '字'.repeat(100),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, true);
  });
});

describe('v1.17.94 — 禁止依賴 context 的詞（未來 AI 看不懂）', () => {
  const forbidPhrases = ['上次', '之前那個', '剛剛', '這次 session', '這次對話'];

  for (const phrase of forbidPhrases) {
    it(`內容含「${phrase}」 → 失敗`, () => {
      const r = lintIronRule({
        title: '測試標題夠長',
        content: `## 什麼時候適用\n寫程式時\n## 規則\n不要做 ${phrase} 提到的那種事。` + '字'.repeat(100),
        tags: ['trigger:edit'],
      });
      assert.equal(r.ok, false, `phrase=「${phrase}」應失敗`);
      assert.match(r.errors.join('|'), /context|脈絡|看不懂|依賴/,
        '錯誤訊息應提到依賴 context 問題');
    });
  }

  it('沒這些詞 → 通過該項', () => {
    const r = lintIronRule({
      title: '不依賴 context 的鐵律',
      content: '## 什麼時候適用\n寫程式時\n## 規則\n禁止做不對的事。' + '字'.repeat(100),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, true);
  });
});

describe('v1.17.94 — 中英混雜檢查（IR-037 落地）', () => {
  it('連續英文詞太多（非技術詞白名單）→ 失敗', () => {
    const r = lintIronRule({
      title: '混雜的鐵律',
      content: '## 什麼時候適用\nyou are coding the system component for example when refactoring the workflow\n## 規則\nyou should not just hide data behind filter conditions instead change the actual logic.' + 'a'.repeat(100),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('|'), /中英|混雜|English/,
      '錯誤訊息應提到中英混雜');
  });

  it('白名單技術詞（SQL / API / IR-XXX / OwnMind）不算混雜', () => {
    const r = lintIronRule({
      title: '只用白名單技術詞的鐵律',
      content: '## 什麼時候適用\n寫 SQL 改 API 動到 OwnMind 的時候\n## 規則\n要遵守 IR-027、不能把 WHERE 條件當作藏資料的手段。' + '字'.repeat(100),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, true, `白名單詞不該觸發中英混雜、errors: ${JSON.stringify(r.errors)}`);
  });
});

describe('v1.17.94 — 字數檢查', () => {
  it('content 少於 100 字 → 失敗（資訊不足）', () => {
    const r = lintIronRule({
      title: '太短的鐵律',
      content: '## 什麼時候適用\n寫程式\n## 規則\n要小心',
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('|'), /太短|資訊不足|字數/);
  });

  it('content 超過 3000 字 → 失敗（要點不明）', () => {
    const r = lintIronRule({
      title: '太長的鐵律',
      content: '## 什麼時候適用\n寫程式時\n## 規則\n要小心\n' + '字'.repeat(3500),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('|'), /太長|要點不明|字數/);
  });
});

describe('v1.17.94 — title 檢查', () => {
  it('title 少於 10 字 → 失敗', () => {
    const r = lintIronRule({
      title: '太短',
      content: '## 什麼時候適用\n寫程式時\n## 規則\n要小心。' + '字'.repeat(100),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('|'), /title|標題/);
  });

  it('title 多於 100 字 → 失敗', () => {
    const r = lintIronRule({
      title: '這個鐵律的標題很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長',
      content: '## 什麼時候適用\n寫程式時\n## 規則\n要小心。' + '字'.repeat(100),
      tags: ['trigger:edit'],
    });
    assert.equal(r.ok, false);
    assert.match(r.errors.join('|'), /title|標題/);
  });
});

describe('v1.17.94 — memory.js 整合：iron_rule POST/PUT 接入 lint', () => {
  // 靜態斷言、不跑實際 endpoint
  const memorySrc = fs.readFileSync(path.join(repoRoot, 'src/routes/memory.js'), 'utf8');

  it('memory.js 必須 import lintIronRule', () => {
    assert.match(memorySrc, /import\s*\{\s*lintIronRule\s*\}\s*from\s*['"]\.\.\/utils\/iron-rule-quality\.js['"]/,
      'memory.js 必須 import lintIronRule');
  });

  it('POST / 對 type=iron_rule 必須呼叫 lintIronRule', () => {
    const m = memorySrc.match(/router\.post\('\/'[\s\S]+?(?=\nrouter\.|\nexport)/);
    assert.ok(m, '找不到 POST / handler');
    assert.match(m[0], /lintIronRule\s*\(/,
      'POST / 必須在 iron_rule 寫入前呼叫 lintIronRule');
  });

  it('PUT /:id 對 iron_rule 更新也必須呼叫 lintIronRule', () => {
    const m = memorySrc.match(/router\.put\('\/:id'[\s\S]+?(?=\nrouter\.|\nexport)/);
    assert.ok(m, '找不到 PUT /:id handler');
    assert.match(m[0], /lintIronRule\s*\(/,
      'PUT /:id 必須在 iron_rule 更新前呼叫 lintIronRule');
  });
});

describe('v1.17.94 — Dogfood reviewer Minor 8：v1.17.94 enforcement 的核心鐵律自己也要過 lint', () => {
  // reviewer 指：v1.17.94 想 enforce 「鐵律品質」、核心參考鐵律 IR-027 + IR-006
  // 自己也要過、不然設計有內部矛盾
  it('IR-027「提醒無效、邏輯才有效」過 lint', () => {
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
    assert.equal(r.ok, true, `IR-027 該過、errors: ${JSON.stringify(r.errors)}`);
  });

  it('IR-006「學到東西必須全層同步更新」過 lint', () => {
    const ir006 = {
      title: '學到東西必須全層同步更新',
      content: `## 規則
學到新東西時、必須一次性更新所有相關層級（Skill、Adapter、Spec、Memory、Project status）、不可只改一處就停。

## 適用情境
所有知識更新、踩坑後的教訓、新技術導入。`,
      tags: ['trigger:edit', 'trigger:commit'],
    };
    const r = lintIronRule(ir006);
    assert.equal(r.ok, true, `IR-006 該過、errors: ${JSON.stringify(r.errors)}`);
  });
});

describe('v1.17.94 — Dogfood：用 lint 重跑 IR-039 應該過', () => {
  // 這是 dogfooding — v1.17.94 的 lint 設計是因為 IR-039 重寫過 3 次才寫好
  // 如果 IR-039 過不了、表示 lint 規則太嚴；如果 IR-039 過得了、表示
  // 規則合理可接受
  it('IR-039 內容套用 lint 應通過', () => {
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
    assert.equal(r.ok, true, `IR-039 不該被 lint 擋下、errors: ${JSON.stringify(r.errors)}`);
  });
});
