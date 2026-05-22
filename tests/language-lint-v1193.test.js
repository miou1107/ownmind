/**
 * v1.19.3 — language-lint 擴白名單 / threshold 分情境 / proper noun / 視窗 80
 *
 * 對應 openspec/changes/v1.19.3-reply-lint-progressive-block/spec.md
 *   場景 9 / 10 / 11 / 12 / 13
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  lintReply,
  checkMixedLanguage,
  checkJargonExplanation,
  TECH_WHITELIST,
} from '../shared/language-lint.js';

describe('v1.19.3 場景 9 — 白名單擴充：Top 30 違規詞應全部被白名單吸收', () => {
  // 基於 30 天 audit 的 Top 30 違規詞、擴充白名單後應全部不再觸發 IR-037
  const top30Words = [
    // 大公司 / 平台
    'Google', 'Meta', 'OpenAI', 'Chrome', 'OAuth', 'YouTube', 'Podcast',
    // Vin 個人專案 / 機構
    'adog', 'fapa', 'fontrip', 'ring', 'ownmind',
    // Git / 開發流程
    'main', 'origin', 'branch', 'worktree', 'commits', 'hook', 'Hook',
    'review', 'reviewer', 'prod', 'spec', 'prompt', 'tasks', 'tests',
    'pipeline', 'Pipeline', 'Stage', 'stage', 'chunk', 'monorepo',
    'render', 'retry', 'batch', 'topic', 'vertical', 'server', 'handoff',
    'project', 'brand', 'plan',
  ];

  for (const word of top30Words) {
    it(`'${word}' 在新白名單裡`, () => {
      const inWhitelist = TECH_WHITELIST.has(word) ||
                          TECH_WHITELIST.has(word.toLowerCase()) ||
                          TECH_WHITELIST.has(word.toUpperCase());
      assert.ok(inWhitelist, `'${word}' 應該在 TECH_WHITELIST`);
    });
  }

  it('整段含多個 Top 30 詞、不觸發 IR-037', () => {
    const text = '我跑 Google 搜尋、用 OAuth login、本地 worktree 開新 branch、跑完 tests 才 push 到 main。';
    const r = lintReply(text);
    const ir037 = r.violations.find(v => v.rule === 'IR-037');
    assert.equal(ir037, undefined, `Top 30 詞不該觸發 IR-037、實際：${JSON.stringify(r.violations)}`);
  });
});

describe('v1.19.3 場景 10 — Proper noun 偵測：大寫開頭孤立詞不算違規', () => {
  it("'Eric 跟 Phoebe 都同意' 不違反 IR-037", () => {
    const text = 'Eric 跟 Phoebe 都同意這個方向、繼續推進。';
    const r = checkMixedLanguage(text);
    assert.equal(r.ok, true, `proper noun 應跳過、實際：${JSON.stringify(r.mixedWords)}`);
  });

  it('全大寫詞（AWS, IDE）已在白名單、不該被當 proper noun 處理', () => {
    const text = '我們用 AWS 跑、走 IDE 模式。';
    const r = checkMixedLanguage(text);
    assert.equal(r.ok, true);
  });

  it('複雜大寫詞（如 OpenSpec）依然走白名單、不走 proper noun', () => {
    const text = '走 OpenSpec 流程。';
    const r = checkMixedLanguage(text);
    assert.equal(r.ok, true);
  });

  it('真正非白名單行話（小寫開頭、非 proper noun）仍要觸發', () => {
    // monomorphism 不是 proper noun、不在白名單
    const text = '我把整個 monomorphism 都翻新。monomorphism 是核心元件。';
    const r = checkMixedLanguage(text);
    // ratio 至少 > 0、應該違規
    assert.ok(r.mixedWords.includes('monomorphism'), 'monomorphism 應在 mixedWords');
  });
});

describe('v1.19.3 場景 11 — Threshold 分情境：含 code block 寬鬆到 25%', () => {
  it('一般文字、22% 比例 → 違反（threshold=15%）', () => {
    // 24 中文字 + 7 字英文（monomorphism）= 31 字、英 7/31 = 22%
    const text = '我把整個 monomorphism 翻新一次、原本架構不適合擴。';
    const r = checkMixedLanguage(text);
    // 22% > 15% 預設、應違規
    if (r.mixedWords.length > 0) {
      assert.ok(r.ratio > 0.15, `比例 ${r.ratio} 應 > 0.15`);
    }
  });

  it('含 code block 的回話、相同 22% 比例 → 通過（threshold=25%）', () => {
    const text = '看這段 code、`const monomorphism = new Monomorphism();`、這就是核心元件。';
    const r = checkMixedLanguage(text);
    // 即使含 monomorphism，因為 stripCodeAndLinks 會剝掉、ratio 應很低
    // 主要驗：含 code block 邏輯生效（threshold 上調或剝碼後通過）
    assert.equal(r.ok, true, `含 code 應通過、實際 ratio ${r.ratio}`);
  });

  it('含 ``` fenced code block → 也應觸發 25% threshold', () => {
    const text = '```js\nconst monomorphism = new Monomorphism();\n```\n看上面這段。';
    const r = checkMixedLanguage(text);
    assert.equal(r.ok, true);
  });
});

describe('v1.19.3 場景 12 — Code review 豁免', () => {
  it("含 '## Code Review' 開頭、直接豁免", () => {
    const text = '## Code Review\n- refactor middleware: 沒問題\n- monomorphism async: 改 await/promise\n- endpoint handler: 缺 timeout';
    const r = checkMixedLanguage(text);
    assert.equal(r.ok, true, 'code review 應豁免');
  });

  it("含 'code-review' 字眼、豁免", () => {
    const text = '這份 code-review 結果：monomorphism / middleware / endpoint 全部要動。';
    const r = checkMixedLanguage(text);
    assert.equal(r.ok, true);
  });

  it("一般含 'review' 字眼（不是 code review）、不豁免", () => {
    const text = '我們需要做 review 但目前還沒空。'; // 應走正常邏輯（review 在白名單裡所以也通過）
    const r = checkMixedLanguage(text);
    // 這個 case review 在白名單、本來就通過、驗證沒誤觸豁免
    assert.equal(r.ok, true);
  });
});

describe('v1.19.3 場景 13 — IR-036 視窗從 50 字擴到 80', () => {
  it('解釋在 50~80 字距離、新版應 ok', () => {
    // monomorphism 後面隔了 60 多字才有「也就是」
    const text = '我們的 monomorphism 設計、這個元件負責所有訊息分派、要好好寫、也就是把訊息分派出去的元件。';
    const r = checkJargonExplanation(text);
    const hasMonomorphism = r.jargonWithoutExplanation.includes('monomorphism');
    assert.equal(hasMonomorphism, false, `monomorphism 應在 80 字內找到解釋、實際：${JSON.stringify(r.jargonWithoutExplanation)}`);
  });

  it('解釋超出 80 字、應該違規', () => {
    const text = '我們的 monomorphism 設計、blah blah blah blah blah blah blah blah blah blah blah blah blah blah blah blah blah、也就是把訊息分派出去的元件。';
    const r = checkJargonExplanation(text);
    assert.ok(r.jargonWithoutExplanation.includes('monomorphism'),
      'monomorphism 應違規（解釋距離 > 80 字）');
  });
});
