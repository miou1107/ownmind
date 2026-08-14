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

// en.json is hand-authored and spells its safety negations with an uppercase, standalone NOT
// ("this turn was NOT checked", "this command was NOT gated") — the shouting is the point, and
// it doubles as a machine-readable marker for "this value's whole job is to deny that a check
// happened". `never` catches the one negation phrased without it (neverSynced's English says
// both, but a future sibling might say only one).
const EN_DENIES_CHECK = /\bNOT\b|\bnever\b/;
// en.json values that assert the check DID happen. Kept separate because an affirmative notice
// must not drift negative either — lint.recovered's whole purpose is to tell the user the gap
// is over.
const EN_AFFIRMS_CHECK = /\bwas checked\b/;

// Japanese negative predicate suffix. Covers されていません / されませんでした / ありません —
// every polite negative form the dictionary's register would use.
const JA_NEGATIVE_PREDICATE = /ません$/;
// The artifact of the incident: the bracketed negation translated as a noun value. Banned
// outright rather than only on today's five keys — the pipeline that produced it once will
// produce it again on the next string built the same way. Narrowing this ban should be a
// deliberate decision by someone reading a real Japanese sentence that needs it, not a side
// effect of a regenerated dictionary.
const QUOTED_NOUN_ARTIFACT = '「なし」';

const denyKeys = dictKeys(en).filter((k) => EN_DENIES_CHECK.test(en[k]));
const affirmKeys = dictKeys(en).filter((k) => EN_AFFIRMS_CHECK.test(en[k]) && !EN_DENIES_CHECK.test(en[k]));

describe('hooks/locales/ja.json — the Japanese must assert what the English asserts', () => {
  // An empty derived list would make every assertion below vacuous — the same "dead assertion"
  // trap tests/hook-locales-parity.test.js guards its literal list against.
  it('en.json still marks its safety negations with NOT/never (otherwise the checks below run against nothing)', () => {
    assert.ok(
      denyKeys.length > 0,
      'no en.json value contains a standalone NOT/never — either the notices were reworded '
        + '(update EN_DENIES_CHECK to match the new marker) or the safety strings are gone'
    );
    assert.ok(
      affirmKeys.length > 0,
      'no en.json value contains "was checked" — the affirmative-notice assertion below is dead'
    );
  });

  it('every notice whose English denies a check ends on a Japanese negative predicate', () => {
    for (const key of denyKeys) {
      assert.match(
        ja[key].trim(),
        JA_NEGATIVE_PREDICATE,
        `ja.json "${key}" must end on a negative predicate (…ません) because en.json says `
          + `${JSON.stringify(en[key])} — got ${JSON.stringify(ja[key])}`
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
      assert.ok(
        ja[key].includes('チェックされました'),
        `ja.json "${key}" must state affirmatively that the turn was checked, because en.json `
          + `says ${JSON.stringify(en[key])} — got ${JSON.stringify(ja[key])}`
      );
      assert.ok(
        !JA_NEGATIVE_PREDICATE.test(ja[key].trim()),
        `ja.json "${key}" ends on a negative predicate but en.json affirms the check ran `
          + `(got: ${JSON.stringify(ja[key])})`
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
  it('every notice whose English denies a check names the check in ja rather than only negating something else', () => {
    for (const key of denyKeys) {
      assert.ok(
        ja[key].includes('チェックされていません'),
        `ja.json "${key}" never says the check did not happen — a negative predicate about `
          + `some other clause is not the same assertion as en.json's ${JSON.stringify(en[key])} `
          + `(got: ${JSON.stringify(ja[key])})`
      );
    }
  });
});
