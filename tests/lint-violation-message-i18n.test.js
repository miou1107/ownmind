/**
 * The violation line inside a reply-lint banner must speak the reader's language.
 *
 * Found by running the product rather than reading it, 2026-08-19, on a zh-TW machine: the
 * banner header rendered in Chinese and the sentence underneath it — the part that says what
 * is actually wrong — arrived in English:
 *
 *   [OwnMind v1.30.14] 🟢 OwnMind 在 AI 這段回話裡挑到違反你規矩的地方（這個對話第 1 次）。…
 *     ・lint_language_mixed_ratio: Mixed Chinese-English ratio 52.4% > 15% — found 16
 *       non-whitelisted English words (first 5: deployment, succeeded, …). Please use plain Chinese.
 *
 * The rule being enforced there is IR-004, "do not mix Chinese and English", so the product
 * was breaking the rule it was reporting. Cause: v1.21.0 moved the checks into
 * shared/validators/*.js and each one hard-codes its English sentence, while
 * `lint.banner.violationLine` in hooks/locales/*.json is only the "  ・{rule}: {message}"
 * frame — it interpolates whatever it is handed. Every locale therefore rendered a translated
 * frame around an untranslated sentence, and the legacy path it replaced
 * (shared/language-lint.js) had the Chinese wording all along, so this was a regression that
 * looked like a feature that had never existed.
 *
 * What is pinned here:
 *   1. every validator emits a dictionary key plus its parameters, not just a finished string;
 *   2. rendering that key against en.json reproduces the validator's own English byte for
 *      byte — the guard against a dictionary entry drifting away from the sentence the audit
 *      record keeps, which is the drift nobody sees, because the audit record is not read
 *      until something has already gone wrong;
 *   3. zh and ja render neither English nor a bare key.
 *
 * Point 2 matters more than it looks. `t()` returns the KEY when a dictionary entry is
 * missing — not the English fallback — so a validator that names a key nobody added would put
 * `lint.violation.languageMixedRatio` in front of a user, and every existing test would still
 * pass.
 */

import { strict as assert } from 'assert';
import { test, afterEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { check as checkMixed } from '../shared/validators/language-mixed-ratio.js';
import { check as checkJargon } from '../shared/validators/jargon-explanation.js';
import { check as checkPrivacy } from '../shared/validators/privacy-detect.js';
import { resetI18nCacheForTests, t } from '../hooks/lib/i18n.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const localesDir = path.join(repoRoot, 'hooks', 'locales');
const readDict = (locale) =>
  JSON.parse(fs.readFileSync(path.join(localesDir, `${locale}.json`), 'utf8'));

const ORIGINAL_FORCE = process.env.OWNMIND_LOCALE_FORCE;

afterEach(() => {
  if (ORIGINAL_FORCE === undefined) delete process.env.OWNMIND_LOCALE_FORCE;
  else process.env.OWNMIND_LOCALE_FORCE = ORIGINAL_FORCE;
  resetI18nCacheForTests();
});

/**
 * One entry per validator, each carrying input that makes it fail. Written as data so a
 * fourth validator added later is one row here rather than three more copies of the same
 * three assertions — and so a row left out is visible as a missing row.
 */
const CASES = [
  {
    name: 'language_mixed_ratio',
    run: () => checkMixed(
      'I ran the deployment pipeline and the build succeeded. The container registry now has '
      + 'the latest image tag. 我 checked the logs, 沒有 error。Next step is to verify the rollout.',
      { threshold: 0.15 },
    ),
    key: 'lint.violation.languageMixedRatio',
  },
  {
    name: 'jargon_explanation',
    run: () => checkJargon(
      '我們用 monomorphism 把 codeapp 重寫一遍，然後把 idempotent 的部分抽出來，'
      + '再讓 memoization 跟 backpressure 一起處理。',
      {},
      { historicalCorpus: '' },
    ),
    key: 'lint.violation.jargonExplanation',
  },
  {
    name: 'privacy_detect',
    run: () => checkPrivacy(
      '我把結果寄到 someone@example.com，電話是 0912-345-678，你再確認一下。',
      {},
      { userPrompts: [] },
    ),
    key: 'lint.violation.privacyDetect',
  },
];

for (const c of CASES) {
  test(`${c.name}: the fixture really does violate, so the assertions below are about something`, () => {
    const result = c.run();
    assert.equal(result.ok, false, 'fixture stopped violating — the rest of this file proves nothing');
    assert.ok(result.violation, 'a failing check must carry a violation');
  });

  test(`${c.name}: emits a dictionary key and its parameters, not only a finished sentence`, () => {
    const { violation } = c.run();
    assert.equal(violation.messageKey, c.key);
    assert.equal(typeof violation.messageParams, 'object');
    assert.notEqual(violation.messageParams, null);
  });

  test(`${c.name}: every locale defines the key`, () => {
    for (const locale of ['en', 'zh', 'ja']) {
      const dict = readDict(locale);
      assert.equal(
        typeof dict[c.key], 'string',
        `${locale}.json is missing ${c.key} — t() renders the raw key, so a user would read it`,
      );
    }
  });

  test(`${c.name}: en renders byte-identical to the sentence the audit record keeps`, () => {
    const { violation } = c.run();
    process.env.OWNMIND_LOCALE_FORCE = 'en';
    resetI18nCacheForTests();
    assert.equal(t(c.key, violation.messageParams), violation.message);
  });

  for (const locale of ['zh', 'ja']) {
    test(`${c.name}: ${locale} renders a real translation, not English and not the key`, () => {
      const { violation } = c.run();
      process.env.OWNMIND_LOCALE_FORCE = locale;
      resetI18nCacheForTests();
      const rendered = t(c.key, violation.messageParams);
      assert.notEqual(rendered, c.key, 'the key itself reached the user');
      assert.notEqual(rendered, violation.message, `${locale} fell through to the English sentence`);
      // The parameters are values, not prose: word lists and percentages are the same in every
      // language, so only the sentence around them is asserted to differ.
      assert.ok(/[぀-ヿ一-鿿]/.test(rendered), 'no CJK at all — this is not a translation');
      assert.ok(!/\{\w+\}/.test(rendered), 'an unreplaced placeholder survived into the notice');
    });
  }
}
