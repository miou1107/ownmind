// Mechanical parity check across hooks/locales/{zh,en,ja}.json (Task 6 of gate-message-i18n).
//
// hooks/locales/ja.json is produced by the route-C translate pipeline
// (client/src/scripts/translate.mjs --dir hooks/locales), not hand-translated — so unlike
// en.json (regression-pinned byte-for-byte against the hand-authored literals in
// tests/hook-i18n.test.js / tests/hook-notices-i18n.test.js), nothing pins ja.json's exact
// wording. What must still hold, mechanically, no matter what the LLM produced:
//   1. every key present in zh/en also exists in ja (and vice versa — no orphans)
//   2. every {placeholder} in a key's value is the same set across zh, en, and ja
//   3. protocol literals — tokens the gate/lint machinery or the user reply-handshake treats
//      as fixed, regardless of locale — survive untranslated into ja
//
// "APPROVED"/"REJECTED" and the approve-action CLI's invocation path are deliberately not
// checked here: they are hardcoded stdout literals in hooks/lib/approve-action.js, never
// dictionary values, so no locale file contains them to begin with (confirmed by grep before
// writing this file).
//
// ja wording has not had a native-Japanese-speaker review pass yet (Task 7 tracks that) — this
// test only proves the translation is *structurally* safe to ship, not that the phrasing reads
// naturally.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const localesDir = join(repoRoot, 'hooks', 'locales');

function loadLocale(name) {
  const path = join(localesDir, `${name}.json`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`hooks/locales/${name}.json exists but is not valid JSON: ${err.message}`);
  }
}

const zh = loadLocale('zh');
const en = loadLocale('en');
const ja = loadLocale('ja');
const enOverride = loadLocale('en.override');

function dictKeys(dict) {
  return Object.keys(dict).filter((k) => !k.startsWith('_'));
}

function placeholders(str) {
  return [...str.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

// Whether a value opens/closes on whitespace is part of its contract, not incidental
// formatting: compliance.idNote's leading space is the separator between it and whatever
// compliance.blockCapReached / compliance.pushedBack concatenates it onto in
// hooks/lib/compliance-step.js (a template literal, no separator of its own) — drop the
// space and the two sentences run together with no gap. Presence, not the exact character, is
// what is compared: zh/ja lead with an ideographic space in places, en with an ASCII one, and
// that difference is legitimate; a key having a leading/trailing space in one locale but not
// another is not.
function edgeWhitespace(str) {
  return { leading: /^\s/.test(str), trailing: /\s$/.test(str) };
}

// Fixed tokens that must survive translation unchanged in every locale: the block glyph, the
// false-positive report phrase the AI is told to listen for (hooks/lib/compliance-step.js:124
// embeds this same Chinese phrase even in the English string — it is the fixed handshake
// phrase, not untranslated leftover Chinese), and the re-enable slash command the offReminder
// notice points users at. `/ownmind-off` (the command that got OwnMind disabled in the first
// place) was listed here too, but no dictionary value has ever told the user to type it — only
// `/ownmind-on` (how to turn it back on) appears — so it never matched anything and the
// coverage test below would fail loudly if it, or any future addition, went the same way.
const OTHER_PROTOCOL_LITERALS = ['⛔', '誤判', '/ownmind-on'];
const OWNMIND_HEADER = /^\[OwnMind[^\]]*\]/;

// hooks/locales/zh.json quotes the "go"/"no" reply keywords with 「」 (its own convention);
// en.json renders that as ASCII "go"/"no"; ja.json is free to use either, since both are valid
// quoting styles for the *same* literal English word — what must not happen is the word itself
// being translated (e.g. into a native yes/no) or appearing unquoted, which would make it
// indistinguishable from running prose (compliance.notChecked.noCredentials legitimately
// contains the ordinary English word "no" — checking for a bare, unquoted "go"/"no" substring
// would wrongly flag that key, so the check requires the quote delimiters).
const REPLY_KEYWORDS = ['go', 'no'];
function quotedForm(word) {
  // Require a *matching* delimiter pair: ASCII "word" or the CJK bracket 「word」, never a mix
  // of the two. An independent open-class/close-class regex (`["「]word["」]`) would also
  // accept "word」 or 「word" — an opening delimiter from one style paired with a closing
  // delimiter from the other — which is not a real quoting convention either locale uses and
  // must not count as "quoted".
  return new RegExp(`(?:"${word}"|「${word}」)`);
}

describe('hooks/locales dictionary parity (zh / en / ja)', () => {
  it('all three locale files exist and parse as JSON', () => {
    assert.ok(zh, 'hooks/locales/zh.json must exist');
    assert.ok(en, 'hooks/locales/en.json must exist');
    assert.ok(ja, 'hooks/locales/ja.json must exist — run `npm run translate:hooks` to generate it');
  });

  it('every key in zh.json exists in en.json and ja.json', () => {
    const zhKeys = dictKeys(zh);
    assert.ok(zhKeys.length > 0, 'zh.json should have keys to compare');
    for (const key of zhKeys) {
      assert.ok(key in en, `en.json is missing "${key}"`);
      assert.ok(key in ja, `ja.json is missing "${key}"`);
    }
  });

  it('en.json and ja.json carry no orphan keys beyond zh.json', () => {
    const zhKeys = new Set(dictKeys(zh));
    for (const key of dictKeys(en)) {
      assert.ok(zhKeys.has(key), `en.json has an orphan key "${key}" not in zh.json`);
    }
    for (const key of dictKeys(ja)) {
      assert.ok(zhKeys.has(key), `ja.json has an orphan key "${key}" not in zh.json`);
    }
  });

  it('every key has the same {placeholder} set across zh, en, and ja', () => {
    for (const key of dictKeys(zh)) {
      const zhPh = placeholders(zh[key]);
      const enPh = placeholders(en[key]);
      const jaPh = placeholders(ja[key]);
      assert.deepEqual(enPh, zhPh, `en.json "${key}" placeholders ${JSON.stringify(enPh)} != zh.json's ${JSON.stringify(zhPh)}`);
      assert.deepEqual(jaPh, zhPh, `ja.json "${key}" placeholders ${JSON.stringify(jaPh)} != zh.json's ${JSON.stringify(zhPh)}`);
    }
  });

  it('the bracketed [OwnMind ...] header survives verbatim in ja wherever en has one', () => {
    for (const key of dictKeys(en)) {
      const match = en[key].match(OWNMIND_HEADER);
      if (!match) continue;
      assert.ok(
        ja[key].startsWith(match[0]),
        `ja.json "${key}" is missing the exact header "${match[0]}" (got: ${JSON.stringify(ja[key])})`
      );
    }
  });

  it('quoted reply-keyword literals ("go" / "no") survive untranslated in ja (either quoting style)', () => {
    for (const key of dictKeys(zh)) {
      for (const word of REPLY_KEYWORDS) {
        const pattern = quotedForm(word);
        if (pattern.test(zh[key])) {
          assert.ok(pattern.test(ja[key]), `ja.json "${key}" lost the quoted reply keyword "${word}" (got: ${JSON.stringify(ja[key])})`);
        }
      }
    }
  });

  // quotedForm() builds its regex from two independent character classes for the open and
  // close delimiter (`["「]` ... `["」]`), which accepts any combination of the two, not just
  // the two real quoting conventions. A string quoted with an ASCII open and a CJK close (or
  // vice versa) is not actually quoted in either style, so it must not match.
  it('quotedForm() requires a matching delimiter pair, not an ASCII/CJK mix', () => {
    const pattern = quotedForm('go');
    assert.ok(!pattern.test('"go」'), 'ASCII open quote + CJK close bracket must not match');
    assert.ok(!pattern.test('「go"'), 'CJK open bracket + ASCII close quote must not match');
    // The two real quoting styles must still match (no assertion weakened by the tightening).
    assert.ok(pattern.test('"go"'), 'ASCII "go" must still match');
    assert.ok(pattern.test('「go」'), 'CJK 「go」 must still match');
  });

  it('other protocol literals (⛔, 誤判, /ownmind-on) survive untranslated in ja', () => {
    for (const key of dictKeys(en)) {
      for (const literal of OTHER_PROTOCOL_LITERALS) {
        if (en[key].includes(literal)) {
          assert.ok(ja[key].includes(literal), `ja.json "${key}" lost the protocol literal "${literal}"`);
        }
      }
    }
  });

  // A literal listed in OTHER_PROTOCOL_LITERALS but present in no dictionary is false
  // confidence: the test above only fires its assertion when `en[key].includes(literal)` is
  // true for some key, so an absent literal silently never exercises anything and the list
  // entry sits there looking like coverage without providing any. Requiring the literal to
  // appear in at least one zh.json value (the hand-written source of truth) turns a silently
  // dead entry into a loud failure instead of relying on someone noticing it by eye.
  it('every literal in OTHER_PROTOCOL_LITERALS actually appears in zh.json somewhere (a listed-but-absent literal is a dead assertion)', () => {
    for (const literal of OTHER_PROTOCOL_LITERALS) {
      const appearsInSource = dictKeys(zh).some((key) => zh[key].includes(literal));
      assert.ok(
        appearsInSource,
        `OTHER_PROTOCOL_LITERALS lists "${literal}" but no zh.json value contains it, so the `
          + 'parity assertion for it never runs against anything — remove it from the list or '
          + 'add the missing source string'
      );
    }
  });

  // hooks/locales/en.override.json is what stops the route-C translate pipeline from sending
  // the hand-authored English through the LLM: the pipeline consults the override before it
  // translates, so a key present there is pinned and a key missing from it is not. Its own
  // _comment claims every key stays in lockstep with en.json, but nothing enforced that claim —
  // so editing en.json alone (adding a key, or rewording an existing one) would silently
  // un-pin that string and let the next `npm run translate:hooks` regenerate the gate's own
  // English block notices through a model. These are the exact literals other suites pin
  // byte-for-byte; drift here is how they would start moving.
  it('en.override.json pins every en.json key, with identical values (no drift)', () => {
    assert.ok(enOverride, 'hooks/locales/en.override.json must exist');
    const enKeys = dictKeys(en);
    const overrideKeys = dictKeys(enOverride);
    assert.deepEqual(
      [...overrideKeys].sort(), [...enKeys].sort(),
      'en.override.json and en.json must carry the same key set — a key in en.json but not in '
        + 'the override is unpinned and will be re-translated by the LLM; a key only in the '
        + 'override pins a string that no longer exists'
    );
    for (const key of enKeys) {
      assert.equal(
        enOverride[key], en[key],
        `en.override.json "${key}" has drifted from en.json — the override is what the translate `
          + 'pipeline actually emits, so the two must be byte-identical'
      );
    }
  });

  it('leading/trailing whitespace presence matches across zh, en, and ja for every key', () => {
    for (const key of dictKeys(zh)) {
      const zhEdge = edgeWhitespace(zh[key]);
      const enEdge = edgeWhitespace(en[key]);
      const jaEdge = edgeWhitespace(ja[key]);
      assert.deepEqual(
        enEdge, zhEdge,
        `en.json "${key}" leading/trailing whitespace ${JSON.stringify(enEdge)} != zh.json's ${JSON.stringify(zhEdge)} (en: ${JSON.stringify(en[key])}, zh: ${JSON.stringify(zh[key])})`
      );
      assert.deepEqual(
        jaEdge, zhEdge,
        `ja.json "${key}" leading/trailing whitespace ${JSON.stringify(jaEdge)} != zh.json's ${JSON.stringify(zhEdge)} (ja: ${JSON.stringify(ja[key])}, zh: ${JSON.stringify(zh[key])})`
      );
    }
  });
});
