// v1.26.56 — event and type keys are labelled through the locale dictionary,
// not through a hardcoded Chinese map.
//
// The legacy console holds a literal `ZH` object at src/public/index.html:1055
// mapping ~35 keys to Chinese. Copying it into the console would put Chinese
// strings into a build that also serves `en` and `ja` — the exact thing the
// project's i18n rule forbids.
//
// t() already falls back to the key itself when the dictionary has no entry,
// which would surface the literal string "stats.label.some_new_event" on screen
// the first time the server emits an event nobody has translated yet. So the
// fallback has to be the raw key, and that is what these tests pin.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statsLabel, STATS_LABEL_PREFIX } from '../client/src/pages/Team/stats-labels.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// A stand-in for useT(): resolves only what the fake dictionary holds, and
// otherwise returns the key — the same contract as client/src/i18n/index.js.
function fakeT(dict) {
  return (key) => dict[key] ?? key;
}

describe('statsLabel', () => {
  it('resolves a known key through the dictionary', () => {
    const t = fakeT({ [`${STATS_LABEL_PREFIX}iron_rule`]: '鐵律' });
    assert.equal(statsLabel('iron_rule', t), '鐵律');
  });

  it('falls back to the raw key, never to the dotted lookup path', () => {
    const t = fakeT({});
    assert.equal(statsLabel('some_new_event', t), 'some_new_event');
  });

  it('an empty or missing key yields an empty string rather than "undefined"', () => {
    const t = fakeT({});
    assert.equal(statsLabel('', t), '');
    assert.equal(statsLabel(null, t), '');
    assert.equal(statsLabel(undefined, t), '');
  });

  it('a null tool from the database is labelled through its own dictionary entry', () => {
    // activity_logs.tool is nullable; GROUP BY tool yields a null key, which
    // becomes the literal string "null" once it is an object key. Legacy printed
    // it raw. No special case in the function — "null" is just a key like any
    // other, and the dictionary carries an entry for it (asserted below).
    const t = fakeT({ [`${STATS_LABEL_PREFIX}null`]: '未知' });
    assert.equal(statsLabel('null', t), '未知');
  });
});

describe('the three locale files carry the stats keys', () => {
  const locales = ['zh', 'en', 'ja'].map((l) => [
    l,
    JSON.parse(readFileSync(join(repoRoot, `client/src/i18n/${l}.json`), 'utf8')),
  ]);

  it('every stats.* key in zh.json exists in en.json and ja.json', () => {
    const zh = locales.find(([l]) => l === 'zh')[1];
    const statsKeys = Object.keys(zh).filter((k) => k.startsWith('stats.'));
    assert.ok(statsKeys.length > 0, 'zh.json should carry stats.* keys after this stage');
    for (const [name, dict] of locales) {
      for (const key of statsKeys) {
        assert.ok(key in dict, `${name}.json is missing ${key}`);
      }
    }
  });

  it('the two keys that only ever arrive from a NULL column are present', () => {
    // `stats.label.null` comes from a NULL tool surviving GROUP BY; `unknown` is
    // what the trigger chart substitutes for a missing trigger name. Neither is
    // reachable from the code by name, so nothing else would catch their loss.
    for (const [name, dict] of locales) {
      assert.ok(`${STATS_LABEL_PREFIX}null` in dict, `${name}.json is missing the null label`);
      assert.ok(`${STATS_LABEL_PREFIX}unknown` in dict, `${name}.json is missing the unknown label`);
    }
  });

  it('no stats.* value in en.json is left as untranslated Chinese', () => {
    // Catches the copy-paste that produces an "en" build showing 鐵律. `ja` is
    // deliberately exempt: it legitimately writes these terms in kanji, so the
    // same check there would fire on correct translations.
    const han = /[一-鿿]/;
    for (const [name, dict] of locales) {
      if (name !== 'en') continue;
      for (const [key, value] of Object.entries(dict)) {
        if (!key.startsWith('stats.')) continue;
        assert.ok(!han.test(value), `${name}.json ${key} still contains Han characters: ${value}`);
      }
    }
  });
});
