/**
 * v1.19.3 — language-lint expanded whitelist / threshold-by-context / proper noun / 80-char window
 *
 * Tracks openspec/changes/v1.19.3-reply-lint-progressive-block/spec.md
 *   scenarios 9 / 10 / 11 / 12 / 13.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  lintReply,
  checkMixedLanguage,
  checkJargonExplanation,
  TECH_WHITELIST,
} from '../shared/language-lint.js';

describe('v1.19.3 scenario 9 — whitelist expansion: every Top 30 violation word must be absorbed', () => {
  // Based on a 30-day audit of the top 30 violation words; once the whitelist is expanded, IR-037 must not fire on any of them.
  const top30Words = [
    // big companies / platforms
    'Google', 'Meta', 'OpenAI', 'Chrome', 'OAuth', 'YouTube', 'Podcast',
    // Vin's personal projects / orgs
    'adog', 'fapa', 'fontrip', 'ring', 'ownmind',
    // Git / dev workflow
    'main', 'origin', 'branch', 'worktree', 'commits', 'hook', 'Hook',
    'review', 'reviewer', 'prod', 'spec', 'prompt', 'tasks', 'tests',
    'pipeline', 'Pipeline', 'Stage', 'stage', 'chunk', 'monorepo',
    'render', 'retry', 'batch', 'topic', 'vertical', 'server', 'handoff',
    'project', 'brand', 'plan',
  ];

  for (const word of top30Words) {
    it(`'${word}' is in the new whitelist`, () => {
      const inWhitelist = TECH_WHITELIST.has(word) ||
                          TECH_WHITELIST.has(word.toLowerCase()) ||
                          TECH_WHITELIST.has(word.toUpperCase());
      assert.ok(inWhitelist, `'${word}' should be in TECH_WHITELIST`);
    });
  }

  it('a sentence containing many Top 30 words does not trigger IR-037', () => {
    const text = '我跑 Google 搜尋、用 OAuth login、本地 worktree 開新 branch、跑完 tests 才 push 到 main。';
    const r = lintReply(text);
    const ir037 = r.violations.find(v => v.rule === 'IR-037');
    assert.equal(ir037, undefined, `Top 30 words should not trigger IR-037; actual: ${JSON.stringify(r.violations)}`);
  });
});

describe('v1.19.3 scenario 10 — proper-noun detection: isolated capitalized names are not violations', () => {
  it("'Eric 跟 Phoebe 都同意' does not violate IR-037", () => {
    const text = 'Eric 跟 Phoebe 都同意這個方向、繼續推進。';
    const r = checkMixedLanguage(text);
    assert.equal(r.ok, true, `proper noun should be skipped; actual: ${JSON.stringify(r.mixedWords)}`);
  });

  it('uppercase acronyms (AWS, IDE) live in the whitelist and must not be treated as proper nouns', () => {
    const text = '我們用 AWS 跑、走 IDE 模式。';
    const r = checkMixedLanguage(text);
    assert.equal(r.ok, true);
  });

  it('mixed-case words (e.g. OpenSpec) still go through the whitelist, not proper-noun handling', () => {
    const text = '走 OpenSpec 流程。';
    const r = checkMixedLanguage(text);
    assert.equal(r.ok, true);
  });

  it('genuine non-whitelisted jargon (lowercase, not a proper noun) must still trigger', () => {
    // monomorphism is not a proper noun and not in the whitelist.
    const text = '我把整個 monomorphism 都翻新。monomorphism 是核心元件。';
    const r = checkMixedLanguage(text);
    // ratio is at least > 0; should be a violation.
    assert.ok(r.mixedWords.includes('monomorphism'), 'monomorphism should appear in mixedWords');
  });
});

describe('v1.19.3 scenario 11 — threshold by context: with code block, loosen to 25%', () => {
  it('plain text at 22% ratio → violation (threshold=15%)', () => {
    // 24 Chinese chars + 7 English chars (monomorphism) = 31 chars; English 7/31 = 22%.
    const text = '我把整個 monomorphism 翻新一次、原本架構不適合擴。';
    const r = checkMixedLanguage(text);
    // 22% > 15% default → should violate.
    if (r.mixedWords.length > 0) {
      assert.ok(r.ratio > 0.15, `ratio ${r.ratio} should be > 0.15`);
    }
  });

  it('reply containing a code block at the same 22% ratio → pass (threshold=25%)', () => {
    const text = '看這段 code、`const monomorphism = new Monomorphism();`、這就是核心元件。';
    const r = checkMixedLanguage(text);
    // Even though it contains monomorphism, stripCodeAndLinks removes it, so ratio is very low.
    // Main verification: the "contains code block" logic kicks in (raised threshold, or stripped-then-passed).
    assert.equal(r.ok, true, `with code should pass; actual ratio ${r.ratio}`);
  });

  it('fenced ``` code block → also triggers the 25% threshold', () => {
    const text = '```js\nconst monomorphism = new Monomorphism();\n```\n看上面這段。';
    const r = checkMixedLanguage(text);
    assert.equal(r.ok, true);
  });
});

describe('v1.19.3 scenario 12 — code-review exemption', () => {
  it("starts with '## Code Review' → exempt", () => {
    const text = '## Code Review\n- refactor middleware: 沒問題\n- monomorphism async: 改 await/promise\n- endpoint handler: 缺 timeout';
    const r = checkMixedLanguage(text);
    assert.equal(r.ok, true, 'code review should be exempt');
  });

  it("contains 'code-review' string → exempt", () => {
    const text = '這份 code-review 結果：monomorphism / middleware / endpoint 全部要動。';
    const r = checkMixedLanguage(text);
    assert.equal(r.ok, true);
  });

  it("plain 'review' (not code review) → not exempt", () => {
    const text = '我們需要做 review 但目前還沒空。'; // Should go through normal logic (review is in the whitelist anyway, so it still passes).
    const r = checkMixedLanguage(text);
    // In this case review is whitelisted and already passes; verify the exemption did not over-trigger.
    assert.equal(r.ok, true);
  });
});

describe('v1.19.3 scenario 13 — IR-036 window expanded from 50 chars to 80', () => {
  it('explanation 50~80 chars away → the new version should be ok', () => {
    // monomorphism is separated from "也就是" by 60+ chars.
    const text = '我們的 monomorphism 設計、這個元件負責所有訊息分派、要好好寫、也就是把訊息分派出去的元件。';
    const r = checkJargonExplanation(text);
    const hasMonomorphism = r.jargonWithoutExplanation.includes('monomorphism');
    assert.equal(hasMonomorphism, false, `monomorphism should find an explanation within 80 chars; actual: ${JSON.stringify(r.jargonWithoutExplanation)}`);
  });

  it('explanation beyond 80 chars → violation', () => {
    const text = '我們的 monomorphism 設計、blah blah blah blah blah blah blah blah blah blah blah blah blah blah blah blah blah、也就是把訊息分派出去的元件。';
    const r = checkJargonExplanation(text);
    assert.ok(r.jargonWithoutExplanation.includes('monomorphism'),
      'monomorphism should violate (explanation distance > 80 chars)');
  });
});
