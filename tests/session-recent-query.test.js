import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { buildSessionRecentQuery } = await import('../src/lib/session-query.js');

/**
 * v1.17.13 — GET /api/session/recent adds a `q` parameter (reported by Michelle)
 *
 * Michelle used `ownmind_search` to search "ai_kol" / "Selenium" / "趨勢" and all returned empty.
 * Root cause: the search endpoint only queries the memories table, but session_logs (written by
 * ownmind_log_session) is a separate table, so it always misses.
 *
 * Fix: add a q query to /api/session/recent that can ILIKE-search summary+details.
 * On the MCP side, ownmind_search then calls both endpoints and merges the results.
 */

describe('buildSessionRecentQuery — pure function', () => {
  it('no q — legacy behavior: filter by user_id + days', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 7 });
    assert.match(q.text, /WHERE user_id = \$1/);
    assert.match(q.text, /created_at >= NOW\(\) - INTERVAL '1 day' \* \$2/);
    assert.doesNotMatch(q.text, /ILIKE/);
    assert.deepEqual(q.values, [6, 7]);
  });

  it('has q — adds ILIKE filter on summary + details', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 30, q: 'ai_kol' });
    assert.match(q.text, /ILIKE/);
    // summary or details::text must match (details is JSONB, needs a cast)
    assert.match(q.text, /summary\s+ILIKE/);
    assert.match(q.text, /details::text[\s\S]{0,20}ILIKE/);
    // q is passed into values as a %...% pattern
    const qIdx = q.values.findIndex((v) => typeof v === 'string' && v.startsWith('%') && v.endsWith('%'));
    assert.ok(qIdx >= 0, `expected pattern, got: ${JSON.stringify(q.values)}`);
    assert.equal(q.values[qIdx], '%ai_kol%');
  });

  it('has tool filter — AND tool = $N', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 7, tool: 'cursor' });
    assert.match(q.text, /AND tool = \$\d+/);
    assert.ok(q.values.includes('cursor'));
  });

  it('filters compressed when includeCompressed=false', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 7, includeCompressed: false });
    assert.match(q.text, /AND compressed = false/);
  });

  it('does not filter when includeCompressed=true', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 7, includeCompressed: true });
    assert.doesNotMatch(q.text, /compressed\s*=\s*false/);
  });

  it('ORDER BY created_at DESC', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 7 });
    assert.match(q.text, /ORDER BY created_at DESC/);
  });

  it('q + tool combination', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 7, q: 'Spec', tool: 'cursor' });
    assert.match(q.text, /ILIKE/);
    assert.match(q.text, /AND tool = \$\d+/);
    assert.ok(q.values.includes('%Spec%'));
    assert.ok(q.values.includes('cursor'));
  });

  it('q is wrapped into a %q% pattern, original not unwrapped', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 7, q: '50%' });
    // % is a wildcard in ILIKE; user-entered % passes through as-is (documented in the ILIKE spec)
    assert.ok(q.values.includes('%50%%'));
  });

  it('empty q is treated as no q', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 7, q: '' });
    assert.doesNotMatch(q.text, /ILIKE/);
  });
});
