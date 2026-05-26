import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkJargonExplanation, lintReply } from '../shared/language-lint.js';

/**
 * v1.20.2 follow-up #3: IR-036 cross-reply vocabulary memory.
 *
 * Background: the rule text says "if it was already explained in context, you
 * may leave it unchanged," but the lint logic never implemented that. Eric's
 * bug: after explaining "actor" / "source" once in a session, later replies
 * were still being blocked by lint.
 *
 * Fix: checkJargonExplanation and lintReply both accept a historicalCorpus
 * second argument.
 *   - Pre-scan the history; add already-explained terms to seenWords.
 *   - In later replies, those terms no longer count as "first occurrence" and
 *     do not violate.
 */

describe('v1.20.2 follow-up #3: IR-036 cross-reply vocabulary memory', () => {

  describe('checkJargonExplanation with historical corpus', () => {
    it('"actor" explained in history + later reply uses actor without a gloss → no violation', () => {
      const history = '我來說明 actor（即爬蟲程式單元）的設計';
      const current = '繼續講 actor 的職責';
      const result = checkJargonExplanation(current, history);
      assert.equal(result.ok, true,
        `actor was explained in history; should not violate: ${JSON.stringify(result)}`);
    });

    it('"source" explained in history + later reply uses source without a gloss → no violation', () => {
      const history = 'source：資料來源';
      const current = '從 source 拿資料';
      const result = checkJargonExplanation(current, history);
      assert.equal(result.ok, true,
        `source was explained in history; should not violate: ${JSON.stringify(result)}`);
    });

    it('multiple terms explained in history; later reply uses several → no violation', () => {
      const history = '我來說明 actor（即爬蟲）跟 dispatch（即派發）的關係。pipeline 即流程';
      const current = 'actor 收到 dispatch 後跑 pipeline';
      const result = checkJargonExplanation(current, history);
      assert.equal(result.ok, true,
        `all three terms were explained in history; should not violate: ${JSON.stringify(result)}`);
    });

    it('term not explained in history; later reply uses it → violation (regression guard)', () => {
      const history = '我來說明 actor（即爬蟲程式單元）的設計';
      const current = '另外提一下 newterm';
      const result = checkJargonExplanation(current, history);
      assert.equal(result.ok, false,
        `newterm was not explained in history; should violate: ${JSON.stringify(result)}`);
      assert.ok(result.jargonWithoutExplanation.includes('newterm'),
        `violation list should contain newterm: ${JSON.stringify(result)}`);
    });

    it('history using the ":" gloss format → recognized', () => {
      const history = 'webhook：當某事件發生時自動觸發的回呼';
      const current = '我用 webhook 接收通知';
      const result = checkJargonExplanation(current, history);
      assert.equal(result.ok, true);
    });

    it('history using the "即" gloss format → recognized', () => {
      const history = 'middleware 即中間層攔截器';
      const current = 'middleware 設計很重要';
      const result = checkJargonExplanation(current, history);
      assert.equal(result.ok, true);
    });

    it('history using the "也就是" gloss format → recognized', () => {
      const history = 'rebase、也就是把分支重新基於另一條分支';
      const current = 'rebase 比 merge 乾淨';
      const result = checkJargonExplanation(current, history);
      assert.equal(result.ok, true);
    });

    it('empty historicalCorpus → behaves like the legacy call (backward compatible)', () => {
      const current = '我用 newterm 來處理';
      const result1 = checkJargonExplanation(current, '');
      const result2 = checkJargonExplanation(current);
      assert.deepEqual(result1, result2,
        'empty corpus and omitted argument should produce the same result');
    });

    it('historicalCorpus null/undefined → no crash; behaves like legacy', () => {
      const current = '我用 newterm 來處理';
      const resultNull = checkJargonExplanation(current, null);
      const resultUndefined = checkJargonExplanation(current, undefined);
      const baseline = checkJargonExplanation(current);
      assert.deepEqual(resultNull, baseline);
      assert.deepEqual(resultUndefined, baseline);
    });
  });

  describe('lintReply with historical corpus', () => {
    it('term explained in history + later short reply → IR-036 not falsely triggered', () => {
      const history = '我來說明 actor（即爬蟲程式單元）跟 loop（即循環任務）的設計';
      const current = '對話中所有工作都完成了 — 終止 loop';
      const result = lintReply(current, history);
      const ir036 = result.violations.find(v => v.rule === 'IR-036');
      assert.equal(ir036, undefined,
        `should not trigger IR-036: ${JSON.stringify(result.violations)}`);
    });

    it('lintReply called without history argument → behaves like legacy (backward compatible)', () => {
      const current = '我用 webhook 來接收';
      const result1 = lintReply(current);
      const result2 = lintReply(current, '');
      assert.deepEqual(result1, result2);
    });
  });
});
