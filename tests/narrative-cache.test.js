import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNarrativeCache } from '../src/lib/narrative-cache.js';

describe('narrativeCache', () => {
  it('get immediately after set returns the value', () => {
    const c = createNarrativeCache({ ttlMs: 1000 });
    c.set('k1', { foo: 1 });
    assert.deepEqual(c.get('k1'), { foo: 1 });
  });

  it('get returns null after expiry', () => {
    let now = 0;
    const c = createNarrativeCache({ ttlMs: 1, now: () => now });
    c.set('k2', 'v');
    now = 100;
    assert.equal(c.get('k2'), null);
  });

  it('different keys do not affect each other', () => {
    const c = createNarrativeCache({ ttlMs: 1000 });
    c.set('a', 1); c.set('b', 2);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('b'), 2);
  });

  it('expired entry is removed from store after get', () => {
    let now = 0;
    const c = createNarrativeCache({ ttlMs: 10, now: () => now });
    c.set('x', 1);
    now = 20;
    assert.equal(c.get('x'), null);
    // store should be empty after expired get
    assert.equal(c.size(), 0);
  });
});
