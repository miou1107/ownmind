// v1.26.64 — Bug #11: what a memory search is allowed to answer with.
//
// Before this, `GET /api/memory/search` was `SELECT *` with no `LIMIT`, so a common
// keyword returned every match in full. Roughly a quarter of a million characters, past
// the tool-output ceiling, which meant the caller received nothing usable. A search that
// returns everything returns nothing.
//
// Shared, not server-side, because mcp/offline.js searches a local cache with the same
// unbounded shape. `tokenize` already lives in shared/ so the two paths tokenize
// identically; the same argument applies to what they hand back.

/** How much of `content` a search result carries. Enough to judge relevance, not to read. */
export const PREVIEW_CHARS = 400;

/** How many rows a search answers with. */
export const SEARCH_ROW_LIMIT = 20;

/**
 * The columns a search result carries. An allow-list on purpose.
 *
 * A deny-list would have to be updated every time `memories` gains a column, and forgetting
 * is silent: the column simply joins every search response. That is how `previous_content`
 * — a second complete copy of the text, kept so an edit can be undone — came to be sent
 * with every result, alongside `metadata`, which for an iron rule holds the whole
 * `origin_context` block including the quote that produced it.
 */
const KEPT_COLUMNS = [
  'id', 'type', 'title', 'code', 'tags', 'status', 'tier', 'created_at', 'updated_at',
];

/**
 * @param {Array<object>} rows  Matching rows, already ordered.
 * @param {object} [options]
 * @param {number} [options.limit]  Rows to keep. Defaults to SEARCH_ROW_LIMIT.
 * @param {number} [options.total]  The real match count, for a caller that applied its
 *   own LIMIT in SQL and therefore never held them all. Defaults to `rows.length`.
 * @returns {{ data: Array<object>, total: number, returned: number }}
 */
export function shapeSearchResults(rows, options = {}) {
  if (!Array.isArray(rows)) return { data: [], total: 0, returned: 0 };

  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? options.limit
    : SEARCH_ROW_LIMIT;
  const total = Number.isInteger(options.total) ? options.total : rows.length;

  const data = rows.slice(0, limit).map((r) => {
    const shaped = {};
    for (const key of KEPT_COLUMNS) shaped[key] = r?.[key] ?? null;

    const content = String(r?.content ?? '');
    shaped.content = content.slice(0, PREVIEW_CHARS);
    shaped.content_length = content.length;
    // No ellipsis appended: a reader comparing content_length against content.length
    // must not be off by characters this function added.
    shaped.content_truncated = content.length > PREVIEW_CHARS;
    return shaped;
  });

  return { data, total, returned: data.length };
}
