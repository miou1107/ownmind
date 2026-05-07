import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNarrativeCache } from '../src/lib/narrative-cache.js';

describe('narrativeCache', () => {
  it('set 後立刻 get 拿得到', () => {
    const c = createNarrativeCache({ ttlMs: 1000 });
    c.set('k1', { foo: 1 });
    assert.deepEqual(c.get('k1'), { foo: 1 });
  });

  it('過期後 get 回 null', () => {
    let now = 0;
    const c = createNarrativeCache({ ttlMs: 1, now: () => now });
    c.set('k2', 'v');
    now = 100;
    assert.equal(c.get('k2'), null);
  });

  it('不同 key 互不影響', () => {
    const c = createNarrativeCache({ ttlMs: 1000 });
    c.set('a', 1); c.set('b', 2);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('b'), 2);
  });

  it('過期 entry get 後從 store 移除', () => {
    let now = 0;
    const c = createNarrativeCache({ ttlMs: 10, now: () => now });
    c.set('x', 1);
    now = 20;
    assert.equal(c.get('x'), null);
    // store should be empty after expired get
    assert.equal(c.size(), 0);
  });
});
