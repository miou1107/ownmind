// Meaning-level guard on hooks/locales/ja.json (gate-message-i18n task 7 follow-up).
//
// tests/hook-locales-parity.test.js proves ja.json is *structurally* safe (same keys, same
// placeholders, protocol literals intact). It cannot catch the defect this file exists for:
// a Japanese value that is structurally perfect and asserts the OPPOSITE of the English.
//
// The incident: hooks/locales/zh.json writes its safety negations inside emphasis brackets —
// 這個指令「沒有」被把關 / 這一輪「沒有」被檢查 — and the route-C translate pipeline rendered the
// bracketed 「沒有」 as if it were a value rather than the sentence's negation, producing
//   「[OwnMind] ゲートが起動せず、この指示は「なし」でチェックされました」
// whose final predicate されました is completed passive: it tells a Japanese reader the command
// WAS checked, while en.json says "this command was NOT gated". A machine whose OS locale is
// `ja` gets Japanese with no opt-in, so a user would have been told a fail-open was a
// successful check and acted on it.
//
// What is asserted here is the property that was violated, not the strings that were written:
// in Japanese the sentence-final predicate carries the assertion, so a notice whose English
// says NOT must end on a negative predicate (…ません), and must not carry the quoted-noun
// artifact 「なし」 that swallowed the negation. The key list is derived from en.json's own
// uppercase "NOT" marker rather than hardcoded, so a future safety notice added to the
// dictionaries is covered the day it lands.
//
// If a future rewording legitimately puts the negation mid-sentence and ends on something
// else, this test fails — deliberately. Rewording a fail-open notice should require someone
// to look at it, not slip through.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const localesDir = join(repoRoot, 'hooks', 'locales');

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

const en = loadLocale('en');
const ja = loadLocale('ja');
const jaOverride = loadLocale('ja.override');

function dictKeys(dict) {
  return Object.keys(dict).filter((k) => !k.startsWith('_'));
}

// v1.30.1: the deny/affirm sets come from the KEYS, not from English prose.
//
// They used to be derived by scanning en.json for a standalone "NOT"/"never". That broke the
// first time the English was reworded — which happened wholesale in v1.30.1 — in both
// directions at once: it stopped recognising the notices it exists to protect (their new
// English says "did not check" rather than "was NOT checked"), and it started claiming
// `compliance.off.warnMode` was one, because that string legitimately says OwnMind "never asks
// the AI to rewrite" — a denial about a different thing entirely. A test whose subject list is
// assembled from adjectives in the sentence it is checking will always be one rewording away
// from covering nothing.
//
// A key name is what actually carries the intent, and it survives copy edits.
const DENY_KEY = /^compliance\.notChecked\.|^compliance\.off\.server$|^gate\.failopen$/;
const AFFIRM_KEY = /^lint\.recovered$/;

// The English still has to *be* a denial. Without this the key list could quietly point at a
// string somebody reworded into an all-clear, and every Japanese assertion below would go on
// passing against the wrong English.
const EN_DENIES_CHECK = /\bnot\b|\bnever\b|\bcould not\b/i;

// The assertion in Japanese is carried by the predicate attached to the check itself, and it
// need not be sentence-final: "OwnMind はこの指示をチェックできず、AI はそのまま実行しました"
// denies the check in a mid-sentence continuative and then ends on an unrelated verb. What
// must never appear in one of these is the completed affirmative — that is the shape the
// v1.26.174 pipeline produced, and it says the opposite of what the notice is for.
const JA_CHECK_DENIED = /(?:チェック|確認)(?:されていません|していません|できず|できません|できませんでした|されませんでした)/;
const JA_CHECK_AFFIRMED = /(?:チェック|確認)(?:されました|しました)/;
// The artifact of the incident: the bracketed negation translated as a noun value. Banned
// outright rather than only on today's five keys — the pipeline that produced it once will
// produce it again on the next string built the same way. Narrowing this ban should be a
// deliberate decision by someone reading a real Japanese sentence that needs it, not a side
// effect of a regenerated dictionary.
const QUOTED_NOUN_ARTIFACT = '「なし」';

const denyKeys = dictKeys(en).filter((k) => DENY_KEY.test(k));
const affirmKeys = dictKeys(en).filter((k) => AFFIRM_KEY.test(k));

describe('hooks/locales/ja.json — the Japanese must assert what the English asserts', () => {
  // An empty derived list would make every assertion below vacuous — the same "dead assertion"
  // trap tests/hook-locales-parity.test.js guards its literal list against.
  it('the key lists still resolve, and the English behind them still denies a check', () => {
    assert.ok(
      denyKeys.length > 0,
      'no key matched DENY_KEY — the safety notices were renamed or removed, and every '
        + 'assertion below is now vacuous'
    );
    assert.ok(
      affirmKeys.length > 0,
      'no key matched AFFIRM_KEY — the affirmative-notice assertion below is dead'
    );
    // The guard the prose-derived version used to provide for free: a key list is only the
    // right subject if the English under it is still a denial.
    for (const key of denyKeys) {
      assert.match(
        en[key],
        EN_DENIES_CHECK,
        `en.json "${key}" is on the deny list but no longer denies anything — either it was `
          + 'reworded into an all-clear (a bug in its own right) or DENY_KEY is pointing at '
          + `the wrong string (got: ${JSON.stringify(en[key])})`
      );
    }
    for (const key of affirmKeys) {
      assert.doesNotMatch(
        en[key],
        EN_DENIES_CHECK,
        `en.json "${key}" is on the affirm list but reads as a denial (got: ${JSON.stringify(en[key])})`
      );
    }
  });

  it('every notice whose English denies a check denies it in Japanese too', () => {
    for (const key of denyKeys) {
      assert.match(
        ja[key],
        JA_CHECK_DENIED,
        `ja.json "${key}" must say the check did NOT happen, because en.json says `
          + `${JSON.stringify(en[key])} — got ${JSON.stringify(ja[key])}`
      );
      assert.doesNotMatch(
        ja[key],
        JA_CHECK_AFFIRMED,
        `ja.json "${key}" states the check completed — that is the exact v1.26.174 defect, a `
          + `notice about an unprotected turn reading as an all-clear (got: ${JSON.stringify(ja[key])})`
      );
    }
  });

  it('no ja.json value smuggles a negation into the quoted noun 「なし」', () => {
    for (const key of dictKeys(ja)) {
      assert.ok(
        !ja[key].includes(QUOTED_NOUN_ARTIFACT),
        `ja.json "${key}" contains ${QUOTED_NOUN_ARTIFACT}, the pattern that turned `
          + '"was NOT checked" into "was checked, with none" — express the negation in the '
          + `predicate instead (got: ${JSON.stringify(ja[key])})`
      );
    }
  });

  it('a notice whose English says the check DID happen stays affirmative in ja', () => {
    for (const key of affirmKeys) {
      assert.match(
        ja[key],
        JA_CHECK_AFFIRMED,
        `ja.json "${key}" must state affirmatively that the reply was checked, because en.json `
          + `says ${JSON.stringify(en[key])} — got ${JSON.stringify(ja[key])}`
      );
      assert.doesNotMatch(
        ja[key],
        JA_CHECK_DENIED,
        `ja.json "${key}" denies the check but en.json affirms it ran — this notice's whole `
          + `purpose is to tell the user the gap is over (got: ${JSON.stringify(ja[key])})`
      );
    }
  });

  // ja.json is pipeline output; ja.override.json is what survives the next
  // `npm run translate:hooks` (applyOverride runs last, after the LLM result is merged in).
  // A hand correction written to only one of the two is a fix with a fuse on it: either it
  // ships and then evaporates on the next regeneration, or it never ships at all.
  it('every ja.override.json pin matches the shipped ja.json value exactly', () => {
    const pinned = dictKeys(jaOverride);
    assert.ok(pinned.length > 0, 'ja.override.json has no pins — this assertion would be vacuous');
    for (const key of pinned) {
      assert.equal(
        ja[key],
        jaOverride[key],
        `ja.override.json pins "${key}" to a value ja.json does not carry — the shipped `
          + 'dictionary and the pin that protects it have drifted apart'
      );
    }
  });

  // The corrected notices are the ones a user reads when the gate did NOT protect them, so
  // each must actually say so rather than merely avoid the banned artifact. Deriving the
  // expectation from en.json again (not from a copy of the Japanese) keeps this from
  // degenerating into a restatement of the string it is checking.
  // v1.30.1: this used to require the literal チェックされていません, which is one of several
  // correct ways to say it and forbade the rest — gate.failopen legitimately reads
  // "…チェックできず、AI はそのまま実行しました". The property is that the negation attaches to the
  // check, and that is now asserted by JA_CHECK_DENIED in the test above, so this one keeps
  // only the part that assertion does not cover: the notice must name what was not done, not
  // merely contain a negative somewhere.
  it('a deny notice names the check itself, not just some other clause', () => {
    for (const key of denyKeys) {
      assert.ok(
        /チェック|確認/.test(ja[key]),
        `ja.json "${key}" never mentions the check at all — a negation about some other clause `
          + `is not the same assertion as en.json's ${JSON.stringify(en[key])} `
          + `(got: ${JSON.stringify(ja[key])})`
      );
    }
  });
});
