import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lintReply } from '../shared/language-lint.js';

/**
 * v1.17.95 — AI 回話品質 lint（IR-037 + IR-036 程式邏輯卡控）
 *
 * 為什麼存在：
 *   Vin 反覆違反 IR-037（中英混雜）跟 IR-036（行話沒附白話說明）。
 *   既有機制：AI 自己事後 report violate — 依賴 AI 自覺、IR-027 違反。
 *
 *   v1.17.95：寫 standalone lint script、未來整合 Stop hook 後可自動掃
 *   每輪 AI 回話、抓違反、強制讓 user + AI 都看到。這個 session 先寫純函式 +
 *   獨立 script、Stop hook 整合留下個 version。
 *
 * 重用：
 *   v1.17.94 的 src/utils/iron-rule-quality.js 已有 checkMixedLanguage 邏輯。
 *   抽到 shared/language-lint.js 共用、iron_rule lint + reply lint 都用同一份。
 */

describe('v1.17.95 — IR-037 中英混雜檢查（回話端）', () => {
  it('全中文回話 ok', () => {
    const r = lintReply('好、那我來修這個問題、先寫測試再實作。');
    assert.equal(r.ok, true);
    assert.equal(r.violations.length, 0);
  });

  it('中英混雜超過 15% 觸發 IR-037 違反', () => {
    const text = 'I think we should refactor the codebase using a different approach because the current implementation has bugs and performance issues.';
    const r = lintReply(text);
    assert.equal(r.ok, false);
    const ir037 = r.violations.find(v => v.rule === 'IR-037');
    assert.ok(ir037, '該找到 IR-037 違反');
    assert.match(ir037.message, /中英混雜|混雜比例/);
  });

  it('純技術詞白名單（SQL/API/IR-039）不觸發 IR-037', () => {
    const r = lintReply('我跑 SQL 改 API、動到 IR-039 的邏輯、用 npm install 部署。');
    const ir037 = r.violations.find(v => v.rule === 'IR-037');
    assert.equal(ir037, undefined, '純白名單技術詞不該觸發 IR-037');
  });
});

describe('v1.17.95 — IR-036 行話 / 專有名詞必須附白話說明', () => {
  it('專有名詞後面有括號白話說明 ok', () => {
    const r = lintReply('用 pre-commit hook（git 提交前自動跑的腳本）擋住。');
    const ir036 = r.violations.find(v => v.rule === 'IR-036');
    assert.equal(ir036, undefined, '有括號說明不該違反 IR-036');
  });

  it('專有名詞後面有冒號解釋 ok', () => {
    const r = lintReply('要做 refactor：重新寫但不改外部行為。');
    const ir036 = r.violations.find(v => v.rule === 'IR-036');
    assert.equal(ir036, undefined, '有冒號解釋不該違反 IR-036');
  });

  it('非白名單英文詞無說明觸發 IR-036', () => {
    // refactor / hook 都不是 v1.17.94 白名單詞、後面沒附說明
    const r = lintReply('我們要 refactor 這個 hook 不然會壞掉。');
    const ir036 = r.violations.find(v => v.rule === 'IR-036');
    assert.ok(ir036, '該找到 IR-036 違反');
    assert.match(ir036.message, /行話|專有名詞|說明/);
  });

  it('白名單技術詞 SQL / API 不要求附說明', () => {
    const r = lintReply('我跑 SQL 查資料、用 API 上傳。');
    const ir036 = r.violations.find(v => v.rule === 'IR-036');
    assert.equal(ir036, undefined, '白名單詞不該被 IR-036 卡');
  });

  it('同一個非白名單詞重複出現只報一次', () => {
    const r = lintReply('我 refactor 一下。然後再 refactor 一次。第三次 refactor。');
    const ir036 = r.violations.find(v => v.rule === 'IR-036');
    assert.ok(ir036, '該違反');
    // 只報 refactor 一次、不是三次
    const occurrenceCount = (ir036.message.match(/refactor/g) || []).length;
    assert.ok(occurrenceCount <= 1, `refactor 該只報一次、實際 ${occurrenceCount} 次`);
  });
});

describe('v1.17.95 — 回傳格式', () => {
  it('違反列表含 rule code / message / 可選 detail', () => {
    const r = lintReply('I think we should refactor this codebase, completely rewrite everything from scratch, abandon the old approach.');
    assert.ok(Array.isArray(r.violations));
    for (const v of r.violations) {
      assert.ok(v.rule, '每條違反要有 rule code');
      assert.ok(v.message, '每條違反要有 message');
    }
  });

  it('ok=true 當無違反', () => {
    const r = lintReply('好、那就這樣修。');
    assert.equal(r.ok, true);
  });

  it('ok=false 當有任何違反', () => {
    const r = lintReply('I think we should refactor this entire codebase using a much better approach because the current implementation is clearly broken.');
    assert.equal(r.ok, false);
  });
});

describe('v1.17.95 — Dogfood：餵我這 session 的真實訊息進去抓我自己違反', () => {
  // 我這 session 確實違反過 IR-037、餵真實訊息看 lint 抓不抓得到
  it('「pre-commit hook + SQL template literal + wrapper + ESLint rule」這段該抓到', () => {
    const realMessage = `**1. pre-commit hook 掃 SQL 變更（簡單、立刻能做）**
加 git hook 偵測 commit 裡 SQL 模板字串新增的可疑 pattern。`;
    const r = lintReply(realMessage);
    assert.equal(r.ok, false, `該抓到違反、實際：${JSON.stringify(r.violations)}`);
  });
});
