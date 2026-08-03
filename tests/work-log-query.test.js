// v1.26.51 — buildWorkLogQuery() turns the filter state + pagination into the
// URLSearchParams the API expects. Pure so the date-to-ISO conversion is
// executed by tests — that boundary is the exact place the legacy JS put an
// off-by-one bug in an earlier version.
//
// The four things that matter:
//
//   1. Empty / null filters are OMITTED from the params, not set to empty
//      strings. `q=` in the URL would ILIKE '%%' and match everything, which
//      is fine, but `user_id=` would be an integer parse error.
//   2. `from` and `to` YYYY-MM-DD strings are widened to full-day ISO strings
//      (`T00:00:00.000Z` and `T23:59:59.999Z`). The API stores timestamps at
//      the second, and the legacy tab's 從 date meant the whole day, not
//      midnight sharp.
//   3. limit and offset always propagate.
//   4. The URL path is not part of what this returns — the caller composes
//      the full URL from a base + the returned query.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkLogQuery } from '../client/src/pages/System/work-log-query.js';

function readParams(params) {
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

describe('buildWorkLogQuery — pagination always present', () => {
  it('limit + offset always set even with no filters', () => {
    const p = readParams(buildWorkLogQuery({}, 0, 100));
    assert.equal(p.limit, '100');
    assert.equal(p.offset, '0');
  });

  it('offset propagates through', () => {
    const p = readParams(buildWorkLogQuery({}, 500, 100));
    assert.equal(p.offset, '500');
  });
});

describe('buildWorkLogQuery — date widening', () => {
  it('YYYY-MM-DD from is widened to start-of-day UTC', () => {
    const p = readParams(buildWorkLogQuery({ from: '2026-07-01' }, 0, 100));
    assert.equal(p.from, '2026-07-01T00:00:00.000Z');
  });

  it('YYYY-MM-DD to is widened to end-of-day UTC (23:59:59.999)', () => {
    const p = readParams(buildWorkLogQuery({ to: '2026-07-31' }, 0, 100));
    assert.equal(p.to, '2026-07-31T23:59:59.999Z');
  });

  it('empty date strings are dropped, not widened', () => {
    const p = readParams(buildWorkLogQuery({ from: '', to: '' }, 0, 100));
    assert.equal(p.from, undefined);
    assert.equal(p.to, undefined);
  });
});

describe('buildWorkLogQuery — text filters', () => {
  it('every text filter maps to its own query key', () => {
    const p = readParams(buildWorkLogQuery({
      source: 'session',
      user_id: '7',
      tool: 'claude-code',
      event_type: 'init',
      q: 'auth',
    }, 0, 100));
    assert.equal(p.source, 'session');
    assert.equal(p.user_id, '7');
    assert.equal(p.tool, 'claude-code');
    assert.equal(p.event_type, 'init');
    assert.equal(p.q, 'auth');
  });

  it('empty text filters are omitted, not set to empty string', () => {
    const p = readParams(buildWorkLogQuery({
      source: '',
      user_id: '',
      tool: '',
      event_type: '',
      q: '',
    }, 0, 100));
    assert.equal(p.source, undefined);
    assert.equal(p.user_id, undefined);
    assert.equal(p.tool, undefined);
    assert.equal(p.event_type, undefined);
    assert.equal(p.q, undefined);
  });

  it('whitespace-only q is treated as empty and omitted', () => {
    // The legacy JS calls .trim() before including q. Preserve that so an
    // accidental " " query does not return zero rows for no reason.
    const p = readParams(buildWorkLogQuery({ q: '   ' }, 0, 100));
    assert.equal(p.q, undefined);
  });
});

describe('buildWorkLogQuery — types coerce to string', () => {
  it('numeric user_id passed as a number is serialised', () => {
    // Selects sometimes return a number, sometimes a string; be permissive.
    const p = readParams(buildWorkLogQuery({ user_id: 7 }, 0, 100));
    assert.equal(p.user_id, '7');
  });
});
