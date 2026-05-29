import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import {
  sanitizeErrorMessage,
  pushBounded,
  shouldSkipDuplicate,
} from '../shared/helpers.js';

describe('sanitizeErrorMessage', () => {
  it('replaces homedir prefix with ~', () => {
    const home = os.homedir();
    const out = sanitizeErrorMessage(`ENOENT: no such file: ${home}/secret.txt`);
    assert.ok(out.includes('~/secret.txt'));
    assert.ok(!out.includes(home));
  });

  it('redacts sk- API key shapes', () => {
    const out = sanitizeErrorMessage('failed with key sk-abc123_DEF-456 oops');
    assert.match(out, /<redacted>/);
    assert.ok(!out.includes('sk-abc123'));
  });

  it('redacts Bearer tokens', () => {
    const out = sanitizeErrorMessage('Authorization Bearer abc.def-123 invalid');
    assert.match(out, /<redacted>/);
    assert.ok(!out.includes('abc.def-123'));
  });

  it('caps message length at default 80 chars', () => {
    const long = 'x'.repeat(200);
    const out = sanitizeErrorMessage(long);
    assert.ok(out.length <= 83); // 80 + "..."
    assert.ok(out.endsWith('...'));
  });

  it('honors custom maxLen', () => {
    const out = sanitizeErrorMessage('x'.repeat(50), 20);
    assert.ok(out.length <= 23);
  });

  it('handles non-string input safely', () => {
    assert.equal(sanitizeErrorMessage(null), '');
    assert.equal(sanitizeErrorMessage(undefined), '');
    assert.equal(typeof sanitizeErrorMessage(42), 'string');
  });

  it('passes short clean message through unchanged', () => {
    assert.equal(sanitizeErrorMessage('short error'), 'short error');
  });
});

describe('pushBounded', () => {
  it('pushes when under limit', () => {
    const a = [1, 2];
    pushBounded(a, 3, 5);
    assert.deepEqual(a, [1, 2, 3]);
  });

  it('drops oldest when exceeding limit', () => {
    const a = [1, 2, 3];
    pushBounded(a, 4, 3);
    assert.deepEqual(a, [2, 3, 4]);
  });

  it('handles initial array longer than limit', () => {
    const a = [1, 2, 3, 4, 5];
    pushBounded(a, 6, 3);
    assert.deepEqual(a, [4, 5, 6]);
  });

  it('returns the same array (mutating)', () => {
    const a = [1];
    const ret = pushBounded(a, 2, 5);
    assert.equal(ret, a);
  });
});

describe('shouldSkipDuplicate', () => {
  const TTL = 60000;

  it('first occurrence returns false (process)', () => {
    const m = new Map();
    assert.equal(shouldSkipDuplicate(m, 'k1', TTL, 0), false);
    assert.equal(m.get('k1'), 0);
  });

  it('second occurrence within ttl returns true (skip)', () => {
    const m = new Map();
    shouldSkipDuplicate(m, 'k1', TTL, 0);
    assert.equal(shouldSkipDuplicate(m, 'k1', TTL, 30000), true);
  });

  it('does not slide the timestamp on skip (so it eventually expires)', () => {
    const m = new Map();
    shouldSkipDuplicate(m, 'k1', TTL, 0);
    shouldSkipDuplicate(m, 'k1', TTL, 30000); // skip
    // first-seen ts should still be 0, so at t=60001 it expires
    assert.equal(shouldSkipDuplicate(m, 'k1', TTL, 60001), false);
  });

  it('garbage-collects expired entries on each call', () => {
    const m = new Map();
    shouldSkipDuplicate(m, 'old', TTL, 0);
    assert.equal(m.size, 1);
    shouldSkipDuplicate(m, 'new', TTL, 60001);
    // 'old' should be swept out
    assert.equal(m.size, 1);
    assert.ok(!m.has('old'));
    assert.ok(m.has('new'));
  });

  it('different keys are independent', () => {
    const m = new Map();
    shouldSkipDuplicate(m, 'a', TTL, 0);
    assert.equal(shouldSkipDuplicate(m, 'b', TTL, 1000), false);
  });

  it('minute-boundary edge case (was the bug it fixes)', () => {
    const m = new Map();
    // Same key hit at :59 and :00 back-to-back: the old minute bucket split into two buckets and counted both
    // Sliding window: anything < 60s apart is always skipped
    shouldSkipDuplicate(m, 'k1', TTL, 59000);
    assert.equal(shouldSkipDuplicate(m, 'k1', TTL, 60000), true);
  });
});
