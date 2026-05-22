/**
 * v1.19.5 — 白名單 case-insensitive bug 修補 + 漏字補充
 *
 * 問題：v1.19.3 擴白名單時、`TECH_WHITELIST.has(w.toLowerCase())` 看似有做
 * 大小寫處理、但 Set.has 是精確字串比對：白名單存 'Claude' (PascalCase)、
 * 查 'claude'（小寫）時 has('claude') = false、查 'Claude'.toUpperCase()
 * = 'CLAUDE' 也不在、於是漏判。
 *
 * 真實踩坑（2026-05-22）：Vin 開新 session 測 v1.19.4 block 機制、Claude
 * 自我介紹寫到 `claude`（小寫）+ `terminal`、兩詞都漏判、IR-036 觸發、user
 * 收到 reason「terminal, claude」。terminal 是真漏加白名單、claude 是
 * case-sensitive bug。
 *
 * 修法：
 *   1. 建構 TECH_WHITELIST_LOWER（全 lowercase）一次、查詢全用 lowercase 比對
 *   2. 補漏字：terminal, bump, Suspense, Concurrent, Pod, Saga, Envoy,
 *      Istio, monad, functor, applicative, observable, mergeMap, switchMap,
 *      concatMap, combineLatest, ajax, fromEvent
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkMixedLanguage,
  checkJargonExplanation,
  TECH_WHITELIST,
} from '../shared/language-lint.js';

describe('v1.19.5 case-insensitive bug 修復', () => {
  it("'claude'（小寫）應該被 'Claude' 白名單吸收", () => {
    // 白名單存 'Claude'、查 'claude' 應該命中
    const r = checkMixedLanguage('我在 claude 上跑、reply 都很慢');
    assert.equal(r.mixedWords.includes('claude'), false,
      `claude 不該違規（在白名單 PascalCase）、實際 mixedWords=${JSON.stringify(r.mixedWords)}`);
  });

  it("'CODEX'（大寫）應該被 'Codex' 白名單吸收", () => {
    const r = checkMixedLanguage('用 CODEX 重做一遍');
    assert.equal(r.mixedWords.includes('CODEX'), false);
  });

  it("'cursor'（小寫）應該被 'Cursor' 白名單吸收", () => {
    const r = checkMixedLanguage('在 cursor 編輯時');
    assert.equal(r.mixedWords.includes('cursor'), false);
  });

  it("IR-036 也要 case-insensitive：'claude' 不該被當行話要求解釋", () => {
    const r = checkJargonExplanation('我在 claude 環境跑、然後改了 cursor 設定');
    assert.equal(r.jargonWithoutExplanation.includes('claude'), false);
    assert.equal(r.jargonWithoutExplanation.includes('cursor'), false);
  });
});

describe('v1.19.5 漏字補充', () => {
  // 真實踩坑：Vin v1.19.4 測試 reply 提到 terminal、被當違規
  const missingWords = [
    'terminal', 'bump', 'Suspense', 'Concurrent', 'Pod', 'Saga',
    'Envoy', 'Istio', 'monad', 'functor', 'applicative', 'observable',
    'mergeMap', 'switchMap', 'concatMap', 'combineLatest', 'ajax', 'fromEvent',
    'shell', 'console', 'stdout', 'stderr',
  ];

  for (const word of missingWords) {
    it(`'${word}' 應該在白名單`, () => {
      const inWhitelist = TECH_WHITELIST.has(word) ||
                          TECH_WHITELIST.has(word.toLowerCase());
      assert.ok(inWhitelist, `'${word}' 該加進 TECH_WHITELIST`);
    });
  }

  it('真實踩坑案例：terminal + claude 兩詞都不該觸發違規', () => {
    const text = '招牌會顯示在你的 terminal、claude 看到後會重寫';
    const r1 = checkMixedLanguage(text);
    const r2 = checkJargonExplanation(text);
    assert.equal(r1.mixedWords.length, 0,
      `IR-037 不該違規、實際：${JSON.stringify(r1.mixedWords)}`);
    assert.equal(r2.jargonWithoutExplanation.length, 0,
      `IR-036 不該違規、實際：${JSON.stringify(r2.jargonWithoutExplanation)}`);
  });

  it('真實踩坑案例：v1.19.4 測試 prompt 全部技術詞不該觸發', () => {
    const text = '解釋 Suspense、Concurrent Mode、sidecar、Pod、Istio、Envoy、Saga、choreography、orchestration、monad、functor、applicative、observable、mergeMap、switchMap';
    const r = checkMixedLanguage(text);
    // 所有列出的詞都該在白名單
    const violators = r.mixedWords.filter(w =>
      ['Suspense', 'Concurrent', 'sidecar', 'Pod', 'Istio', 'Envoy', 'Saga',
       'choreography', 'orchestration', 'monad', 'functor', 'applicative',
       'observable', 'mergeMap', 'switchMap'].includes(w)
    );
    assert.equal(violators.length, 0,
      `這些技術詞都該在白名單、實際違規：${JSON.stringify(violators)}`);
  });

  it("'bump' 不該觸發 IR-036（發版常用動詞）", () => {
    const r = checkJargonExplanation('要 bump 版號到 v1.19.5');
    assert.equal(r.jargonWithoutExplanation.includes('bump'), false);
  });
});
