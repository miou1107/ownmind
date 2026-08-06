/**
 * Iron-rule sync helpers for the git pre-commit hook.
 *
 * Both functions here exist because of one defect found on 2026-08-06:
 *
 *   GET /api/memory/type/iron_rule returns `{ data: [...] }`. The hook parsed it
 *   with `Array.isArray(allRules) ? allRules : []`, so every sync produced zero
 *   rules. It then wrote that emptiness over the cache and returned it, and the
 *   caller treats "no rules" as "nothing to check" and exits 0 — silently, with
 *   nothing printed. So a single stale-cache refresh disarmed every iron rule
 *   for the next commit, and the only visible signal was the absence of the
 *   usual "all N rules passed" line.
 *
 * Kept as pure functions in their own module so the response shape and the
 * cache-write decision can be asserted directly, without running the hook.
 */

/**
 * Extract the rules array from whatever the API returned.
 *
 * Accepts the wrapped `{ data: [...] }` envelope the server sends today and a
 * bare array, in case the endpoint is ever unwrapped. Anything else — an error
 * body, a truncated response, non-JSON — yields an empty array rather than
 * throwing, because a sync failure must never abort a commit.
 *
 * @param {string|null|undefined} raw - the raw response body
 * @returns {Array<object>}
 */
export function parseIronRulesResponse(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.data)) return parsed.data;
  return [];
}

/**
 * Decide whether a fetch result may replace the cache on disk.
 *
 * An empty fetch never overwrites a populated cache. Emptiness is far more
 * likely to mean "the sync went wrong" than "the user deleted all their rules",
 * and the cost of guessing wrong is every rule silently unchecked on the next
 * commit. A stale cache still enforces something; an empty one enforces nothing.
 *
 * The cache's own size is deliberately not a parameter: writing an empty result
 * is never useful, whether or not something is already there, and an unused
 * argument is one more thing that can drift out of step with the caller.
 *
 * @param {number} fetchedCount - usable rules the sync produced
 * @returns {boolean}
 */
export function shouldOverwriteCache(fetchedCount) {
  return fetchedCount > 0;
}

export default { parseIronRulesResponse, shouldOverwriteCache };
