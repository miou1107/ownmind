// v1.26.64 — Bug #11's other half.
//
// `ownmind_search` calls GET /api/memory/search and GET /api/session/recent and merges
// them into one response. Bounding only the memory half would leave the same output
// ceiling reachable through the session half, which was `SELECT * FROM session_logs`
// with no LIMIT.
//
// These assertions read the built SQL rather than run it. That is the right level here:
// the defect is a missing clause, and a missing clause is visible in the text. The
// builder is already pure for this reason.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionRecentQuery, SESSION_MAX_LIMIT } from '../src/lib/session-query.js';
import { SEARCH_ROW_LIMIT } from '../shared/memory-search-result.js';

describe('buildSessionRecentQuery — bounded', () => {
  it('carries a LIMIT', () => {
    const { text } = buildSessionRecentQuery({ userId: 1 });
    assert.match(text, /LIMIT/, 'no LIMIT: one query can return every session log the user has');
  });

  it('limits to the shared row count', () => {
    const { text } = buildSessionRecentQuery({ userId: 1 });
    assert.match(text, new RegExp(`LIMIT\\s+${SEARCH_ROW_LIMIT}\\b`));
  });

  it('puts the LIMIT after the ordering, so it keeps the newest', () => {
    const { text } = buildSessionRecentQuery({ userId: 1 });
    const order = text.indexOf('ORDER BY');
    const limit = text.indexOf('LIMIT');
    assert.ok(order > -1 && limit > order, `LIMIT must follow ORDER BY, got: ${text}`);
  });

  it('names its columns instead of selecting everything', () => {
    const { text } = buildSessionRecentQuery({ userId: 1 });
    assert.doesNotMatch(text, /SELECT \*/, 'SELECT * ships columns nobody reads');
  });

  it('still selects what its two readers use', () => {
    // mcp/index.js maps id, summary, details, tool, model, created_at into its merged
    // result; dropping any of them would empty a field the AI reads.
    const { text } = buildSessionRecentQuery({ userId: 1 });
    for (const col of ['id', 'summary', 'details', 'tool', 'model', 'created_at']) {
      assert.match(text, new RegExp(`\\b${col}\\b`), `${col} is no longer selected`);
    }
  });
});

describe('buildSessionRecentQuery — everything else is unchanged', () => {
  it('keeps the compressed filter off by default and on when asked', () => {
    assert.match(buildSessionRecentQuery({ userId: 1 }).text, /compressed = false/);
    assert.doesNotMatch(
      buildSessionRecentQuery({ userId: 1, includeCompressed: true }).text,
      /compressed = false/,
    );
  });

  it('keeps the q predicate over summary and details', () => {
    const { text, values } = buildSessionRecentQuery({ userId: 1, q: 'deploy' });
    assert.match(text, /summary ILIKE/);
    assert.match(text, /details::text/);
    assert.ok(values.includes('%deploy%'));
  });

  it('keeps the tool filter and the parameter order', () => {
    const { values } = buildSessionRecentQuery({ userId: 7, days: 30, tool: 'claude-code', q: 'x' });
    assert.deepEqual(values, [7, 30, 'claude-code', '%x%']);
  });
});

describe('buildSessionRecentQuery — the limit is a parameter, not a constant', () => {
  // Review of v1.26.64 caught the first version hard-coding 20 for every caller. This
  // builder has two: search, which wants a handful merged with memory hits, and
  // ownmind_get('session_log'), which is a listing where 20 hides most of a month.
  it('honours a caller-supplied limit', () => {
    assert.match(buildSessionRecentQuery({ userId: 1, limit: 50 }).text, /LIMIT\s+50\b/);
  });

  it('clamps above the ceiling, so no caller can ask for an unbounded answer', () => {
    assert.match(buildSessionRecentQuery({ userId: 1, limit: 10000 }).text, new RegExp(`LIMIT\\s+${SESSION_MAX_LIMIT}\\b`));
  });

  it('falls back to the search default for a nonsense limit', () => {
    for (const bad of [0, -5, 'abc', null, undefined, 1.5]) {
      assert.match(
        buildSessionRecentQuery({ userId: 1, limit: bad }).text,
        new RegExp(`LIMIT\\s+${SEARCH_ROW_LIMIT}\\b`),
        `limit=${bad} should fall back`,
      );
    }
  });
});
