/**
 * v1.26.37 — shared keyword-search primitives
 *
 * Same tokenization + per-item matching used by:
 *   - src/utils/memory-search-query.js  (online SQL builder)
 *   - mcp/offline.js                    (offline in-memory search)
 *
 * Keeping the semantics in one place stops the two paths from drifting.
 */

const MAX_TOKENS = 10;
const MIN_TOKEN_LEN = 2;

/**
 * Split a raw query string into normalized tokens.
 * - whitespace-split, trim, drop empties
 * - drop tokens shorter than MIN_TOKEN_LEN (single chars would match ~everything
 *   and force a seq-scan across every text/tag/code column)
 * - cap at MAX_TOKENS to bound SQL size and result-set scan work
 * - non-string input → []
 */
export function tokenize(q) {
  if (typeof q !== 'string') return [];
  const parts = q
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= MIN_TOKEN_LEN);
  return parts.slice(0, MAX_TOKENS);
}

/**
 * Does the memory item match ALL tokens (case-insensitive) across any of
 * title / content / code / tags? Mirrors the online SQL predicate exactly so
 * offline cache search does not regress the Bug #7 fix.
 */
export function itemMatchesTokens(item, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return false;
  const haystacks = [];
  if (typeof item?.title === 'string') haystacks.push(item.title.toLowerCase());
  if (typeof item?.content === 'string') haystacks.push(item.content.toLowerCase());
  if (typeof item?.code === 'string') haystacks.push(item.code.toLowerCase());
  if (Array.isArray(item?.tags)) {
    for (const tag of item.tags) {
      if (typeof tag === 'string') haystacks.push(tag.toLowerCase());
    }
  }
  return tokens.every((token) => {
    const lo = token.toLowerCase();
    return haystacks.some((h) => h.includes(lo));
  });
}
