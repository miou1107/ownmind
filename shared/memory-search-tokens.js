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
 * v1.26.156 — the whitespace split above is a language assumption, and it is wrong for the
 * language this product is written in.
 *
 * English arrives pre-tokenized: "wrap up" is two tokens, either of which can match on its
 * own. Chinese has no spaces, so a whole phrase arrives as ONE token and is matched as one
 * literal substring. Measured 2026-08-12 against the live account:
 *
 *   收工六項自檢   → 0 results
 *   收工           → found
 *   交接六項自檢   → found
 *
 * The title is 「[團隊] 收工／交接六項自檢」. Typing the phrase from memory, two characters
 * short of the stored form, returns nothing — and "nothing" is indistinguishable from "you
 * have no such memory", which is the failure this product exists to prevent.
 *
 * The fix is to also match on overlapping two-character windows. 收工六項自檢 yields
 * 收工, 工六, 六項, 項自, 自檢; four of those five appear in the title, and only 工六 is
 * broken by the ／交接 sitting in the middle.
 */
const BIGRAM_MIN_TOKEN_LEN = 4;
const BIGRAM_MATCH_RATIO = 0.6;
const CJK = /[㐀-鿿豈-﫿぀-ヿ]/;

/** Is this token long enough, and script-appropriate, for the window match to mean anything? */
export function isBigramEligible(token) {
  return typeof token === 'string'
    && token.length >= BIGRAM_MIN_TOKEN_LEN
    && CJK.test(token);
}

/** Overlapping two-character windows of a token, lowercased. `[]` when not eligible. */
export function bigrams(token) {
  if (!isBigramEligible(token)) return [];
  const lo = token.toLowerCase();
  const out = [];
  for (let i = 0; i + 2 <= lo.length; i += 1) out.push(lo.slice(i, i + 2));
  return out;
}

/**
 * How many windows must land before a token counts as matched.
 *
 * Not all of them: requiring every window is the same as requiring the exact phrase, which
 * is what fails today. Not one or two either — a 60% floor on a six-character phrase means
 * three windows, which is enough shared text that an unrelated memory does not reach it.
 */
export function bigramThreshold(count) {
  return Math.max(1, Math.ceil(count * BIGRAM_MATCH_RATIO));
}

/**
 * Does the memory item match ALL tokens (case-insensitive) across any of
 * title / content / code / tags? Mirrors the online SQL predicate exactly so
 * offline cache search does not regress the Bug #7 fix.
 *
 * v1.26.156 — a token that is not found whole is retried as windows, against `title` and
 * `content` only. `code` and `tags` are identifiers (`IR-XXX`, `trigger:commit`), not prose;
 * a partial match there says nothing and would put unrelated rows in front of the user.
 */
export function itemMatchesTokens(item, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return false;
  const haystacks = [];
  const prose = [];
  if (typeof item?.title === 'string') {
    haystacks.push(item.title.toLowerCase());
    prose.push(item.title.toLowerCase());
  }
  if (typeof item?.content === 'string') {
    haystacks.push(item.content.toLowerCase());
    prose.push(item.content.toLowerCase());
  }
  if (typeof item?.code === 'string') haystacks.push(item.code.toLowerCase());
  if (Array.isArray(item?.tags)) {
    for (const tag of item.tags) {
      if (typeof tag === 'string') haystacks.push(tag.toLowerCase());
    }
  }
  return tokens.every((token) => {
    const lo = token.toLowerCase();
    if (haystacks.some((h) => h.includes(lo))) return true;
    const windows = bigrams(token);
    if (windows.length === 0) return false;
    const need = bigramThreshold(windows.length);
    // Counted per field, not pooled: windows scattered across a title and an unrelated
    // paragraph of the content are not evidence that either one is what was asked for.
    return prose.some((h) => windows.filter((g) => h.includes(g)).length >= need);
  });
}
