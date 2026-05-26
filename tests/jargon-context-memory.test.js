import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkJargonExplanation, lintReply } from '../shared/language-lint.js';

/**
 * v1.20.2 follow-up #3：IR-036 跨 reply 詞彙記憶
 *
 * 背景：規則內文寫「上下文已說明過、可保留不改」、但 lint 邏輯沒實作。
 * Eric 報的 bug：同 session 第一次解釋過「actor」「source」、後續 reply 仍被 lint 擋。
 *
 * 修法：checkJargonExplanation 跟 lintReply 都加 historicalCorpus 第二參數。
 *   - 預先掃歷史、把已解釋過的詞加進 seenWords
 *   - 後續 reply 內這些詞不再算「第一次出現」、不違反
 */

describe('v1.20.2 follow-up #3：IR-036 跨 reply 詞彙記憶', () => {

  describe('checkJargonExplanation 帶歷史 corpus', () => {
    it('歷史已解釋「actor」+ 後續 reply 用 actor 不附解釋 → 不違反', () => {
      const history = '我來說明 actor（即爬蟲程式單元）的設計';
      const current = '繼續講 actor 的職責';
      const result = checkJargonExplanation(current, history);
      assert.equal(result.ok, true,
        `actor 已在歷史解釋過、不該違反：${JSON.stringify(result)}`);
    });

    it('歷史已解釋「source」+ 後續 reply 用 source 不附解釋 → 不違反', () => {
      const history = 'source：資料來源';
      const current = '從 source 拿資料';
      const result = checkJargonExplanation(current, history);
      assert.equal(result.ok, true,
        `source 已在歷史解釋過、不該違反：${JSON.stringify(result)}`);
    });

    it('歷史多個詞解釋、後續 reply 用其中幾個 → 不違反', () => {
      const history = '我來說明 actor（即爬蟲）跟 dispatch（即派發）的關係。pipeline 即流程';
      const current = 'actor 收到 dispatch 後跑 pipeline';
      const result = checkJargonExplanation(current, history);
      assert.equal(result.ok, true,
        `三個詞都已在歷史解釋過、不該違反：${JSON.stringify(result)}`);
    });

    it('歷史沒解釋過的詞、後續 reply 用 → 違反（regression 防護）', () => {
      const history = '我來說明 actor（即爬蟲程式單元）的設計';
      const current = '另外提一下 newterm';
      const result = checkJargonExplanation(current, history);
      assert.equal(result.ok, false,
        `newterm 沒在歷史解釋過、應該違反：${JSON.stringify(result)}`);
      assert.ok(result.jargonWithoutExplanation.includes('newterm'),
        `違反清單應該含 newterm：${JSON.stringify(result)}`);
    });

    it('歷史用「：」解釋格式 → 認得', () => {
      const history = 'webhook：當某事件發生時自動觸發的回呼';
      const current = '我用 webhook 接收通知';
      const result = checkJargonExplanation(current, history);
      assert.equal(result.ok, true);
    });

    it('歷史用「即」解釋格式 → 認得', () => {
      const history = 'middleware 即中間層攔截器';
      const current = 'middleware 設計很重要';
      const result = checkJargonExplanation(current, history);
      assert.equal(result.ok, true);
    });

    it('歷史用「也就是」解釋格式 → 認得', () => {
      const history = 'rebase、也就是把分支重新基於另一條分支';
      const current = 'rebase 比 merge 乾淨';
      const result = checkJargonExplanation(current, history);
      assert.equal(result.ok, true);
    });

    it('historicalCorpus 為空字串 → 行為跟舊版相同（向後相容）', () => {
      const current = '我用 newterm 來處理';
      const result1 = checkJargonExplanation(current, '');
      const result2 = checkJargonExplanation(current);
      assert.deepEqual(result1, result2,
        '空 corpus 跟省略參數結果應一致');
    });

    it('historicalCorpus 為 null/undefined → 不 crash、行為跟舊版相同', () => {
      const current = '我用 newterm 來處理';
      const resultNull = checkJargonExplanation(current, null);
      const resultUndefined = checkJargonExplanation(current, undefined);
      const baseline = checkJargonExplanation(current);
      assert.deepEqual(resultNull, baseline);
      assert.deepEqual(resultUndefined, baseline);
    });
  });

  describe('lintReply 帶歷史 corpus', () => {
    it('歷史已解釋 + 後續 reply 短句、不會誤觸發 IR-036', () => {
      const history = '我來說明 actor（即爬蟲程式單元）跟 loop（即循環任務）的設計';
      const current = '對話中所有工作都完成了 — 終止 loop';
      const result = lintReply(current, history);
      const ir036 = result.violations.find(v => v.rule === 'IR-036');
      assert.equal(ir036, undefined,
        `不該觸發 IR-036：${JSON.stringify(result.violations)}`);
    });

    it('lintReply 不帶歷史參數 → 跟舊版相同（向後相容）', () => {
      const current = '我用 webhook 來接收';
      const result1 = lintReply(current);
      const result2 = lintReply(current, '');
      assert.deepEqual(result1, result2);
    });
  });
});
