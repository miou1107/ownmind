/**
 * v1.26.37 — Bug #7 (option B) — keyword search SQL builder
 *
 * Consumed by GET /api/memory/search (src/routes/memory.js). Pure function so
 * the test suite can exercise the builder without a live Postgres.
 *
 * See openspec/changes/v1.26.37-improve-keyword-search/proposal.md for
 * background: the pre-v1.26.37 handler did a single ILIKE '%q%' over title OR
 * content only, so multi-word or tag-only or code-only hits were invisible.
 *
 * Tokenization lives in shared/ so the offline (mcp/offline.js) code path
 * uses the same semantics as this online one.
 */

export { tokenize } from '../../shared/memory-search-tokens.js';

/**
 * Escape LIKE metacharacters so a user token containing '%' or '_' matches
 * literally instead of as a wildcard. Postgres treats '\' as the default LIKE
 * escape char, so no explicit ESCAPE clause needed.
 */
function escapeLikePattern(token) {
  return token.replace(/[\\%_]/g, '\\$&');
}

/**
 * Build the WHERE fragment + ORDER BY fragment + params for a keyword search.
 * Each token must appear (case-insensitive) in ANY of:
 *   title, content, code, or any element of the tags text[].
 * Tokens are ANDed (all must hit somewhere).
 *
 * @param {string[]} tokens - tokenized query, empty → returns null
 * @param {number} startingParamIndex - the first $N placeholder to use
 *   (caller has already claimed $1..$N-1 for other params like user_id).
 * @returns {{whereClause: string, orderClause: string, params: string[]} | null}
 */
export function buildSearchWhere(tokens, startingParamIndex = 2) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;

  const params = [];
  const groups = tokens.map((token, i) => {
    const paramIdx = startingParamIndex + i;
    params.push(`%${escapeLikePattern(token)}%`);
    return (
      `(title ILIKE $${paramIdx} OR content ILIKE $${paramIdx} ` +
      `OR code ILIKE $${paramIdx} ` +
      `OR EXISTS (SELECT 1 FROM unnest(COALESCE(tags, ARRAY[]::text[])) t WHERE t ILIKE $${paramIdx}))`
    );
  });

  const whereClause = groups.join(' AND ');
  const firstTokenParam = `$${startingParamIndex}`;
  const orderClause = `(title ILIKE ${firstTokenParam}) DESC, updated_at DESC`;

  return { whereClause, orderClause, params };
}
