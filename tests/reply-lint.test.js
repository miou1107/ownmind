import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lintReply } from '../shared/language-lint.js';

/**
 * v1.17.95 — AI reply quality lint (IR-037 + IR-036 program-logic gate)
 *
 * Why it exists:
 *   Vin kept violating IR-037 (mixed Chinese/English) and IR-036 (jargon
 *   without a plain-language gloss). Existing mechanism: the AI reports
 *   the violation after the fact — depends on the AI's own judgment, which
 *   in turn violates IR-027.
 *
 *   v1.17.95: ship a standalone lint script; once it integrates with the
 *   Stop hook, every AI reply gets scanned automatically and the user +
 *   the AI both see the violations. This session ships the pure functions
 *   + the standalone script; the Stop-hook integration lands in the next version.
 *
 * Reuse:
 *   v1.17.94's src/utils/iron-rule-quality.js already has the
 *   checkMixedLanguage logic. Move it to shared/language-lint.js so
 *   iron_rule lint + reply lint share one copy.
 */

// v1.26.13 regression: rule-driven path was only taken when
// resolvedValidators.length > 0. An EMPTY array (user has no lint_validator
// rules) silently fell through to the legacy fallback which ran every built-in
// check unconditionally — so users without any opt-in jargon/mixed rule still
// got blocked. Fix: an Array second arg means "new API"; empty list means
// "user opted in to nothing" and the lint must return ok=true.
describe('v1.26.13 — rule-driven path: empty validators must skip every check', () => {
  it('empty validators array + content full of bare English jargon → ok (no built-ins fire)', () => {
    const text = '我們用 webpack 跟 vite 來 bundle 程式碼，整體 throughput 改善很多。';
    const r = lintReply(text, [], { historicalCorpus: '', userPrompts: [] });
    assert.equal(r.ok, true, `empty opt-in must skip every check; got violations=${JSON.stringify(r.violations)}`);
    assert.equal(r.violations.length, 0);
  });

  it('empty validators array + heavy mixed-language content → ok (no built-ins fire)', () => {
    const text = 'I think we should refactor the codebase because performance is bad.';
    const r = lintReply(text, [], {});
    assert.equal(r.ok, true);
  });
});

describe('v1.17.95 — IR-037 mixed-language check (reply side)', () => {
  it('all-Chinese reply is ok', () => {
    const r = lintReply('好、那我來修這個問題、先寫測試再實作。');
    assert.equal(r.ok, true);
    assert.equal(r.violations.length, 0);
  });

  it('Chinese/English mix above 15% triggers an IR-037 violation', () => {
    const text = 'I think we should refactor the codebase using a different approach because the current implementation has bugs and performance issues.';
    const r = lintReply(text);
    assert.equal(r.ok, false);
    const ir037 = r.violations.find(v => v.rule === 'lint_language_mixed_ratio');
    assert.ok(ir037, 'should find the IR-037 violation');
    assert.match(ir037.message, /中英混雜|混雜比例/);
  });

  it('whitelisted tech terms (SQL / API / IR-039) do not trigger IR-037', () => {
    const r = lintReply('我跑 SQL 改 API、動到 IR-039 的邏輯、用 npm install 部署。');
    const ir037 = r.violations.find(v => v.rule === 'lint_language_mixed_ratio');
    assert.equal(ir037, undefined, 'pure whitelisted terms should not trigger IR-037');
  });
});

describe('v1.17.95 — IR-036 jargon / proper-noun must come with a plain-language gloss', () => {
  it('proper noun followed by parenthetical gloss is ok', () => {
    const r = lintReply('用 pre-commit hook（git 提交前自動跑的腳本）擋住。');
    const ir036 = r.violations.find(v => v.rule === 'lint_jargon_explanation_required');
    assert.equal(ir036, undefined, 'a parenthetical gloss must not violate IR-036');
  });

  it('proper noun followed by a colon explanation is ok', () => {
    const r = lintReply('要做 refactor：重新寫但不改外部行為。');
    const ir036 = r.violations.find(v => v.rule === 'lint_jargon_explanation_required');
    assert.equal(ir036, undefined, 'a colon explanation must not violate IR-036');
  });

  it('non-whitelisted English term with no gloss triggers IR-036', () => {
    // refactor / hook are not v1.17.94 whitelist terms and have no gloss following them.
    const r = lintReply('我們要 refactor 這個 hook 不然會壞掉。');
    const ir036 = r.violations.find(v => v.rule === 'lint_jargon_explanation_required');
    assert.ok(ir036, 'should find the IR-036 violation');
    assert.match(ir036.message, /行話|專有名詞|說明/);
  });

  it('whitelisted tech terms SQL / API do not require a gloss', () => {
    const r = lintReply('我跑 SQL 查資料、用 API 上傳。');
    const ir036 = r.violations.find(v => v.rule === 'lint_jargon_explanation_required');
    assert.equal(ir036, undefined, 'whitelist terms must not be flagged by IR-036');
  });

  it('the same non-whitelisted term appearing multiple times is reported only once', () => {
    const r = lintReply('我 refactor 一下。然後再 refactor 一次。第三次 refactor。');
    const ir036 = r.violations.find(v => v.rule === 'lint_jargon_explanation_required');
    assert.ok(ir036, 'must violate');
    // refactor should be reported once, not three times.
    const occurrenceCount = (ir036.message.match(/refactor/g) || []).length;
    assert.ok(occurrenceCount <= 1, `refactor should be reported once; actual ${occurrenceCount}`);
  });
});

describe('v1.17.95 — return shape', () => {
  it('violation list contains rule code / message / optional detail', () => {
    const r = lintReply('I think we should refactor this codebase, completely rewrite everything from scratch, abandon the old approach.');
    assert.ok(Array.isArray(r.violations));
    for (const v of r.violations) {
      assert.ok(v.rule, 'every violation must include a rule code');
      assert.ok(v.message, 'every violation must include a message');
    }
  });

  it('ok=true when no violation', () => {
    const r = lintReply('好、那就這樣修。');
    assert.equal(r.ok, true);
  });

  it('ok=false when any violation', () => {
    const r = lintReply('I think we should refactor this entire codebase using a much better approach because the current implementation is clearly broken.');
    assert.equal(r.ok, false);
  });
});

describe('v1.17.95 — Dogfood: feed real session messages and see if lint catches my own violations', () => {
  // I did violate IR-037 in this session — feed the real message and see whether lint catches it.
  it('the "pre-commit hook + SQL template literal + wrapper + ESLint rule" line must be caught', () => {
    const realMessage = `**1. pre-commit hook 掃 SQL 變更（簡單、立刻能做）**
加 git hook 偵測 commit 裡 SQL 模板字串新增的可疑 pattern。`;
    const r = lintReply(realMessage);
    assert.equal(r.ok, false, `should be caught; actual: ${JSON.stringify(r.violations)}`);
  });
});
