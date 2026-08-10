import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { parseMemoryId } = await import('../src/utils/memory-id.js');

// `/api/memory/:id` is registered after every literal path in the router, so any
// unmatched word — `/api/memory/stats`, a typo, a stale client route — arrives here
// as an id. Handing it straight to Postgres produced
// `invalid input syntax for type integer: "stats"`, which the route reported as a
// 500 "Query failed". Measured on production 2026-08-10: `/api/memory/stats` and
// `/api/memory/recent` both 500'd on every call. A 500 says the server broke; the
// server did not break, the path does not exist.
describe('parseMemoryId', () => {
  it('accepts a plain positive integer', () => {
    assert.deepEqual(parseMemoryId('42'), { ok: true, id: 42 });
  });

  it('accepts a number, not only a string', () => {
    assert.deepEqual(parseMemoryId(7), { ok: true, id: 7 });
  });

  it('rejects a word, which is what a wrong path looks like', () => {
    assert.deepEqual(parseMemoryId('stats'), { ok: false });
    assert.deepEqual(parseMemoryId('recent'), { ok: false });
  });

  it('rejects a number with anything attached to it', () => {
    // These parse as 12 under parseInt, which would silently read someone else's row.
    assert.deepEqual(parseMemoryId('12abc'), { ok: false });
    assert.deepEqual(parseMemoryId('12 '), { ok: false });
    assert.deepEqual(parseMemoryId(' 12'), { ok: false });
    assert.deepEqual(parseMemoryId('12.5'), { ok: false });
    assert.deepEqual(parseMemoryId('+12'), { ok: false });
  });

  it('rejects zero and negatives — ids start at 1', () => {
    assert.deepEqual(parseMemoryId('0'), { ok: false });
    assert.deepEqual(parseMemoryId('-3'), { ok: false });
  });

  it('rejects empty, null and undefined', () => {
    assert.deepEqual(parseMemoryId(''), { ok: false });
    assert.deepEqual(parseMemoryId(null), { ok: false });
    assert.deepEqual(parseMemoryId(undefined), { ok: false });
  });

  it('rejects an id too large for a Postgres integer column', () => {
    // memories.id is INT. 2147483647 is the ceiling; one past it is a 22003 error,
    // which is the same class of avoidable 500 this helper exists to stop.
    assert.deepEqual(parseMemoryId('2147483647'), { ok: true, id: 2147483647 });
    assert.deepEqual(parseMemoryId('2147483648'), { ok: false });
    assert.deepEqual(parseMemoryId('99999999999999999999'), { ok: false });
  });

  it('rejects values that are not scalars at all', () => {
    assert.deepEqual(parseMemoryId({}), { ok: false });
    assert.deepEqual(parseMemoryId([]), { ok: false });
    assert.deepEqual(parseMemoryId(['1']), { ok: false });
  });
});
