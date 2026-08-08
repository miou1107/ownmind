import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { matchTemplate, RULE_TEMPLATES } from '../src/utils/templates.js';

/**
 * Bug report #16 (2026-08-06, `Vin-windows-test`).
 *
 * Saving an iron rule used to have the server attach `metadata.verification` to it,
 * silently. Every template in the set carries `block_on_fail: true`, so what came back was
 * a rule that will stop the author's work, with nothing in the response saying so.
 *
 * The reporter guessed the match needed only the tag. It needs a tag AND one keyword — but
 * one keyword anywhere in a long rule is all it takes, which is the same thing in practice.
 * Their example, memory id 829: a rule about not deleting diagnostic logs during rollback,
 * tagged `trigger:deploy`, containing the word 測試 once, was given `deploy_requires_test`.
 * Being blocked by it would have said 「還沒跑測試」.
 *
 * The same mechanism accounts for the eight rules found carrying the docs-staging condition
 * earlier that day, only two of which were about docs. Those were assumed to be
 * hand-copied. They were not.
 *
 * Vin, 2026-08-06, on whether to keep auto-applying the non-blocking ones:
 * 「完全停掉自動套用」. There are no non-blocking ones.
 */

/** The real text of memory 829, trimmed to the parts that decide the match. */
const REPORTED_RULE = {
  title: '失敗處理不能毀掉診斷線索：回滾／清理前，先把日誌搬到不會被還原的地方',
  content: [
    '任何「失敗後自動還原／清理」的動作，都必須先確認它不會把這次失敗的證據一起毀掉。',
    '日誌要寫在還原範圍之外。備份目錄不要在還原後立刻刪除。',
    '這次是靠重新執行 install.sh 並自己接住輸出才找到問題。',
    '但這只有在「失敗可重現」時才行得通——如果是偶發失敗，就得靠測試環境重現。',
  ].join('\n'),
  tags: ['trigger:deploy', 'trigger:rollback', 'trigger:cleanup'],
};

describe('the matcher still fires on the reported rule', () => {
  it('matches deploy_requires_test — one incidental keyword is enough', () => {
    // Kept as a live demonstration of WHY auto-apply had to go. If someone tightens the
    // matching later, this test failing is the signal to re-read the reasoning above, not
    // to relax the assertion.
    assert.equal(matchTemplate(REPORTED_RULE), 'deploy_requires_test');
  });

  it('and that template would have blocked the author', () => {
    const v = RULE_TEMPLATES.deploy_requires_test.verification;
    assert.equal(v.block_on_fail, true);
    assert.equal(v.conditions.message, '還沒跑測試');
  });
});

describe('every template blocks work, which is why none may be auto-applied', () => {
  it('there is no non-blocking template to make an exception for', () => {
    const nonBlocking = Object.entries(RULE_TEMPLATES)
      .filter(([, t]) => !t.verification?.block_on_fail)
      .map(([id]) => id);
    assert.deepEqual(nonBlocking, [],
      'if a reminder-only template is ever added, revisit whether it may auto-apply — '
      + 'that was the option Vin was offered and declined while the set was all-blocking');
  });
});

describe('the save path does not write verification metadata', () => {
  const src = readFileSync(new URL('../src/routes/memory.js', import.meta.url), 'utf8');

  /** The block that handles a template match, from the declaration to the closing brace. */
  const block = /let matched_template = null;[\s\S]*?\n    \}\n/.exec(src);

  it('the match block exists and is the one under test', () => {
    assert.ok(block, 'the matched_template block was not found');
    assert.match(block[0], /matchTemplate\(/);
  });

  it('does not UPDATE memories from inside it', () => {
    assert.doesNotMatch(block[0], /UPDATE memories/,
      'a matched template must not be written to the stored rule');
  });

  it('does not pull a verification payload out of the template set', () => {
    // The block still READS `memory.metadata?.verification` — that is the guard that skips
    // suggesting when the rule already carries one. What it must not do is fetch the
    // template's own verification object, which is the thing that used to get written.
    assert.doesNotMatch(block[0], /RULE_TEMPLATES\s*\[/,
      'the block must not reach into RULE_TEMPLATES for a payload');
    assert.doesNotMatch(block[0], /\.verification\s*;|verification\s*\}/,
      'no verification object may be bound for writing');
  });

  it('does not reassign memory.metadata', () => {
    assert.doesNotMatch(block[0], /memory\.metadata\s*=/);
  });
});

describe('the response says a suggestion was made and not acted on', () => {
  const src = readFileSync(new URL('../src/routes/memory.js', import.meta.url), 'utf8');

  it('carries template_suggestion alongside the bare id', () => {
    // A bare id buried in a large object is how the old behaviour went unnoticed for
    // however long it was live. The caller needs a sentence it can relay.
    assert.match(src, /response\.template_suggestion = \{/);
  });

  it('states applied: false explicitly rather than implying it by absence', () => {
    assert.match(src, /applied: false/);
  });

  it('says whether the suggested template would block work', () => {
    assert.match(src, /blocks_work:/);
  });

  it('the message tells the reader nothing was done', () => {
    assert.match(src, /沒有自動套用/);
  });
});
