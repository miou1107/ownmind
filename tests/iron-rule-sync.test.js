import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseIronRulesResponse, shouldOverwriteCache } from '../hooks/lib/iron-rule-sync.js';

// The exact shape GET /api/memory/type/iron_rule returns, confirmed against
// production on 2026-08-06: an object with a `data` array, not a bare array.
// The pre-commit hook parsed it with `Array.isArray(x) ? x : []`, so every sync
// produced zero rules, wrote that emptiness over the cache, and let the commit
// through in silence.
const REAL_RESPONSE = JSON.stringify({
  data: [
    { id: 20, code: 'IR-008', metadata: { verification: { trigger: ['commit'], conditions: {} } } },
    { id: 121, code: 'IR-026', metadata: { verification: { trigger: ['commit'], conditions: {} } } },
    { id: 999, code: 'IR-999', metadata: {} },
  ],
});

describe('parseIronRulesResponse', () => {
  it('reads the wrapped shape the server actually returns', () => {
    const rules = parseIronRulesResponse(REAL_RESPONSE);
    assert.equal(rules.length, 3, 'the {data: [...]} envelope must be unwrapped');
    assert.equal(rules[0].code, 'IR-008');
  });

  it('still reads a bare array, in case the endpoint is ever unwrapped', () => {
    const rules = parseIronRulesResponse(JSON.stringify([{ code: 'IR-001' }]));
    assert.equal(rules.length, 1);
  });

  it('returns an empty array for unparseable input rather than throwing', () => {
    assert.deepEqual(parseIronRulesResponse('not json at all'), []);
    assert.deepEqual(parseIronRulesResponse(''), []);
    assert.deepEqual(parseIronRulesResponse(null), []);
  });

  it('returns an empty array when the envelope holds something that is not a list', () => {
    assert.deepEqual(parseIronRulesResponse(JSON.stringify({ data: { nope: true } })), []);
    assert.deepEqual(parseIronRulesResponse(JSON.stringify({ error: 'unauthorized' })), []);
  });
});

describe('shouldOverwriteCache', () => {
  it('writes a real result', () => {
    assert.equal(shouldOverwriteCache(5), true);
  });

  it('refuses to write an empty result', () => {
    // This is the destructive half of the defect: one failed sync wiped 27 rules
    // off disk, and the NEXT commit then found an empty cache and skipped every
    // check without printing anything.
    assert.equal(shouldOverwriteCache(0), false);
  });
});

describe('the pre-commit hook uses the shared parser', () => {
  const hook = readFileSync(new URL('../hooks/ownmind-git-pre-commit.js', import.meta.url), 'utf8');

  it('imports it rather than re-implementing the parse inline', () => {
    assert.match(hook, /from '\.\/lib\/iron-rule-sync\.js'/);
    assert.match(hook, /parseIronRulesResponse/);
  });

  it('no longer decides the shape with a bare Array.isArray on the parsed body', () => {
    // The exact expression that caused the defect. Kept as a guard so nobody
    // reintroduces it while the shared parser sits unused next door.
    assert.doesNotMatch(hook, /Array\.isArray\(allRules\)/);
  });

  it('guards the cache write instead of writing unconditionally', () => {
    assert.match(hook, /shouldOverwriteCache/);
  });
});
