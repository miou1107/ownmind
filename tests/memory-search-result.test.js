// v1.26.64 — Bug #11. Search answered with everything it matched: a common keyword came
// back as a quarter of a million characters, past the tool-output ceiling, so the caller
// got nothing usable.
//
// The shaping is pure and shared because mcp/offline.js searches a local cache with the
// same unbounded shape. tokenize already lives in shared/ for that reason; the two paths
// must not answer the same question differently.
//
// The property that matters most is the allow-list: the row must be built by naming what
// to keep. A deny-list would leak every column added to the table later, which is how
// `previous_content` (a second full copy of the text) ended up in a search result nobody
// asked to pay for.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shapeSearchResults, PREVIEW_CHARS, SEARCH_ROW_LIMIT }
  from '../shared/memory-search-result.js';

function row(overrides = {}) {
  return {
    id: 692,
    type: 'project',
    title: 'multi-claude-switcher',
    content: 'short body',
    code: null,
    tags: ['mcs'],
    status: 'active',
    tier: null,
    created_at: '2026-07-21T05:50:35.055Z',
    updated_at: '2026-07-25T04:58:52.042Z',
    // The three this release exists to stop shipping.
    previous_content: 'the entire previous version of the text',
    metadata: { origin_context: { user_quote: 'something the user said' } },
    embedding: null,
    ...overrides,
  };
}

describe('shapeSearchResults — the preview', () => {
  it('truncates a long body and says how much it cut', () => {
    const long = 'x'.repeat(5000);
    const { data } = shapeSearchResults([row({ content: long })]);
    assert.equal(data[0].content.length, PREVIEW_CHARS);
    assert.equal(data[0].content_length, 5000);
    assert.equal(data[0].content_truncated, true);
  });

  it('leaves a short body exactly as it was', () => {
    const short = 'a'.repeat(120);
    const { data } = shapeSearchResults([row({ content: short })]);
    assert.equal(data[0].content, short);
    assert.equal(data[0].content_truncated, false);
    assert.equal(data[0].content_length, 120);
    // No ellipsis bolted on: a reader comparing content_length to content.length must
    // not be off by the characters we added.
    assert.equal(data[0].content.endsWith('…'), false);
  });

  it('handles a row with no content at all', () => {
    const { data } = shapeSearchResults([row({ content: null })]);
    assert.equal(data[0].content, '');
    assert.equal(data[0].content_length, 0);
    assert.equal(data[0].content_truncated, false);
  });
});

describe('shapeSearchResults — what never leaves', () => {
  it('drops previous_content, metadata and embedding', () => {
    const { data } = shapeSearchResults([row()]);
    assert.equal('previous_content' in data[0], false);
    assert.equal('metadata' in data[0], false);
    assert.equal('embedding' in data[0], false);
  });

  it('drops a column it has never heard of', () => {
    // The shape must be an allow-list. With a deny-list, every column added to `memories`
    // in future silently joins every search response.
    const { data } = shapeSearchResults([row({ some_future_column: 'x'.repeat(9000) })]);
    assert.equal('some_future_column' in data[0], false);
  });

  it('keeps what the console and the AI actually read', () => {
    const { data } = shapeSearchResults([row()]);
    for (const key of ['id', 'type', 'title', 'code', 'tags', 'status', 'tier', 'created_at', 'updated_at']) {
      assert.ok(key in data[0], `${key} is missing`);
    }
  });
});

describe('shapeSearchResults — telling a cut list from a whole one', () => {
  it('reports both counts when the list was cut', () => {
    const rows = Array.from({ length: 57 }, (_, i) => row({ id: i }));
    const out = shapeSearchResults(rows, { limit: 20 });
    assert.equal(out.total, 57);
    assert.equal(out.returned, 20);
    assert.equal(out.data.length, 20);
  });

  it('reports equal counts when nothing was cut', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ id: i }));
    const out = shapeSearchResults(rows, { limit: 20 });
    assert.equal(out.total, 12);
    assert.equal(out.returned, 12);
  });

  it('takes a caller-supplied total, for the server that limited in SQL', () => {
    // The route applies LIMIT in the query, so it never holds all 57 rows. It knows the
    // real count from a separate COUNT and passes it in.
    const rows = Array.from({ length: 20 }, (_, i) => row({ id: i }));
    const out = shapeSearchResults(rows, { limit: 20, total: 57 });
    assert.equal(out.total, 57);
    assert.equal(out.returned, 20);
  });

  it('defaults to the shared row limit', () => {
    const rows = Array.from({ length: SEARCH_ROW_LIMIT + 5 }, (_, i) => row({ id: i }));
    assert.equal(shapeSearchResults(rows).returned, SEARCH_ROW_LIMIT);
  });
});

describe('shapeSearchResults — degenerate input', () => {
  it('answers an empty match with zeroes, not null', () => {
    assert.deepEqual(shapeSearchResults([]), { data: [], total: 0, returned: 0 });
  });

  it('does not throw on null or a non-array', () => {
    for (const bad of [null, undefined, 'nope', 42, {}]) {
      assert.deepEqual(shapeSearchResults(bad), { data: [], total: 0, returned: 0 });
    }
  });
});
