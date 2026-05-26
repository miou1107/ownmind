/**
 * v1.19.5 — whitelist case-insensitive bug fix + missing entries
 *
 * Problem: when v1.19.3 expanded the whitelist, `TECH_WHITELIST.has(w.toLowerCase())`
 * looked like case handling, but Set.has is exact string match: the whitelist
 * stores 'Claude' (PascalCase), so has('claude') returns false, and
 * has('Claude'.toUpperCase()) = 'CLAUDE' also misses. Result: missed detection.
 *
 * Real incident (2026-05-22): Vin opened a new session to test the v1.19.4
 * block mechanism; Claude's self-intro included `claude` (lowercase) + `terminal`
 * — both were missed, IR-036 triggered, and the user got the reason
 * "terminal, claude". `terminal` was a genuine missing whitelist entry; `claude`
 * was the case-sensitive bug.
 *
 * Fix:
 *   1. Build TECH_WHITELIST_LOWER (all lowercase) once and compare in lowercase.
 *   2. Add missing entries: terminal, bump, Suspense, Concurrent, Pod, Saga,
 *      Envoy, Istio, monad, functor, applicative, observable, mergeMap, switchMap,
 *      concatMap, combineLatest, ajax, fromEvent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkMixedLanguage,
  checkJargonExplanation,
  TECH_WHITELIST,
} from '../shared/language-lint.js';

describe('v1.19.5 case-insensitive bug fix', () => {
  it("'claude' (lowercase) should be absorbed by the 'Claude' whitelist", () => {
    // The whitelist stores 'Claude'; looking up 'claude' should still hit.
    const r = checkMixedLanguage('我在 claude 上跑、reply 都很慢');
    assert.equal(r.mixedWords.includes('claude'), false,
      `claude should not be flagged (it is whitelisted in PascalCase); actual mixedWords=${JSON.stringify(r.mixedWords)}`);
  });

  it("'CODEX' (uppercase) should be absorbed by the 'Codex' whitelist", () => {
    const r = checkMixedLanguage('用 CODEX 重做一遍');
    assert.equal(r.mixedWords.includes('CODEX'), false);
  });

  it("'cursor' (lowercase) should be absorbed by the 'Cursor' whitelist", () => {
    const r = checkMixedLanguage('在 cursor 編輯時');
    assert.equal(r.mixedWords.includes('cursor'), false);
  });

  it("IR-036 must also be case-insensitive: 'claude' should not be flagged as jargon needing explanation", () => {
    const r = checkJargonExplanation('我在 claude 環境跑、然後改了 cursor 設定');
    assert.equal(r.jargonWithoutExplanation.includes('claude'), false);
    assert.equal(r.jargonWithoutExplanation.includes('cursor'), false);
  });
});

describe('v1.19.5 missing entries added', () => {
  // Real incident: a v1.19.4 reply from Vin mentioned `terminal` and was flagged.
  const missingWords = [
    'terminal', 'bump', 'Suspense', 'Concurrent', 'Pod', 'Saga',
    'Envoy', 'Istio', 'monad', 'functor', 'applicative', 'observable',
    'mergeMap', 'switchMap', 'concatMap', 'combineLatest', 'ajax', 'fromEvent',
    'shell', 'console', 'stdout', 'stderr',
  ];

  for (const word of missingWords) {
    it(`'${word}' should be in the whitelist`, () => {
      const inWhitelist = TECH_WHITELIST.has(word) ||
                          TECH_WHITELIST.has(word.toLowerCase());
      assert.ok(inWhitelist, `'${word}' should be added to TECH_WHITELIST`);
    });
  }

  it('real incident: terminal + claude should both not trigger a violation', () => {
    const text = '招牌會顯示在你的 terminal、claude 看到後會重寫';
    const r1 = checkMixedLanguage(text);
    const r2 = checkJargonExplanation(text);
    assert.equal(r1.mixedWords.length, 0,
      `IR-037 should not flag; actual: ${JSON.stringify(r1.mixedWords)}`);
    assert.equal(r2.jargonWithoutExplanation.length, 0,
      `IR-036 should not flag; actual: ${JSON.stringify(r2.jargonWithoutExplanation)}`);
  });

  it('real incident: v1.19.4 test prompt — none of the tech terms should trigger', () => {
    const text = '解釋 Suspense、Concurrent Mode、sidecar、Pod、Istio、Envoy、Saga、choreography、orchestration、monad、functor、applicative、observable、mergeMap、switchMap';
    const r = checkMixedLanguage(text);
    // All listed words should be in the whitelist.
    const violators = r.mixedWords.filter(w =>
      ['Suspense', 'Concurrent', 'sidecar', 'Pod', 'Istio', 'Envoy', 'Saga',
       'choreography', 'orchestration', 'monad', 'functor', 'applicative',
       'observable', 'mergeMap', 'switchMap'].includes(w)
    );
    assert.equal(violators.length, 0,
      `these tech terms should all be whitelisted; actual violations: ${JSON.stringify(violators)}`);
  });

  it("'bump' should not trigger IR-036 (a common release verb)", () => {
    const r = checkJargonExplanation('要 bump 版號到 v1.19.5');
    assert.equal(r.jargonWithoutExplanation.includes('bump'), false);
  });
});
