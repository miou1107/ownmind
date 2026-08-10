/**
 * v1.26.133 — what a compact init response may and may not be used to cache.
 *
 * `ownmind_init` asks for `/api/memory/init?compact=true`. A compact response deliberately
 * omits the bulk collections: it carries `iron_rules_digest` (a rendered summary) instead of
 * `iron_rules`, and no `team_standards`, `coding_standards`, `projects`, `envs` or
 * `portfolios` at all. Only `profile` and a trimmed `principles` list come back whole.
 *
 * Both caches written at init read that response as though it were the full one:
 *
 *   - `cache/iron_rules.json` was built from `filterCacheableRules(data.iron_rules || [])`,
 *     so every init filtered an empty array and wrote `[]` over whatever was there.
 *   - `cache/memories.json` stored `data.iron_rules || []`, `data.team_standards || []`, and
 *     so on — blanking every type the compact response does not carry.
 *
 * Measured on Windows 2026-08-10, client 1.26.132: the rule cache held the account's only
 * rule carrying a `lint_validator`. One `ownmind_init` reduced it to two bytes, and
 * the reply-lint Stop hook then resolved zero validators for the rest of the session — the
 * silent no-op shared/cacheable-rules.js exists to prevent, reintroduced one layer up. It
 * looked intermittent only because the pre-commit hook rebuilds the cache when it finds it
 * empty: enforcement worked after a commit and nowhere else.
 *
 * The rule below is the whole fix, and it is about one distinction: *absent* is not *empty*.
 * A response that cannot answer must leave the cache as it is.
 */

/**
 * The rule list a cache write may be based on, or null when nothing trustworthy is available.
 *
 * `responseRules` is what the init response carried; `fetchedRules` is the result of asking
 * `/api/memory/type/iron_rule` directly, which the caller only does when the response could
 * not answer. Null means "unknown" — the caller must leave the existing cache alone rather
 * than write an empty list, because an empty list is a claim: it says this account has no
 * cacheable rules, and every consumer believes it.
 *
 * An actual empty array is passed through: an account whose rules are all reminder-only
 * really does cache nothing, and that has to stay distinguishable from a failed lookup.
 *
 * @param {unknown} responseRules
 * @param {unknown} [fetchedRules]
 * @returns {Array<object>|null}
 */
export function pickRulesForCache(responseRules, fetchedRules) {
  if (Array.isArray(responseRules)) return responseRules;
  if (Array.isArray(fetchedRules)) return fetchedRules;
  return null;
}

/**
 * The previous cache's `data`, but only if it belongs to the account configured right now.
 *
 * Merging instead of replacing introduces a question replacing never had to ask: whose data
 * is on disk? Before this release a compact init blanked most collections, so switching the
 * API key to another account cleared them as a side effect of the defect. Keeping them would
 * leave one account's team standards and projects readable under another's key.
 *
 * The rule is the one v1.26.82 established for the SessionStart cache, and it is deliberately
 * strict in the same way: a cache with no `account` stamp at all is treated as somebody
 * else's, not as ours. Every machine restamps on its next init, so the cost of that is one
 * session of the old behaviour and the benefit is that an unattributed file is never trusted.
 *
 * @param {object|null} previousCache the parsed cache file, if any
 * @param {string} fingerprint accountFingerprint({ apiUrl, apiKey }) for the current config
 * @returns {object|null} the previous `data` block, or null when it must not be reused
 */
export function previousDataForAccount(previousCache, fingerprint) {
  if (!previousCache || typeof previousCache !== 'object') return null;
  if (typeof fingerprint !== 'string' || fingerprint === '') return null;
  if (previousCache.account !== fingerprint) return null;
  return previousCache.data && typeof previousCache.data === 'object' ? previousCache.data : null;
}

/**
 * Which init-response field holds each memory type in the offline cache.
 *
 * Exported so a new type added to one side cannot quietly go missing on the other.
 */
export const OFFLINE_CACHE_FIELDS = Object.freeze({
  principle: 'principles',
  iron_rule: 'iron_rules',
  coding_standard: 'coding_standards',
  team_standard: 'team_standards',
  project: 'projects',
  env: 'envs',
  portfolio: 'portfolios',
});

/**
 * Build the `data` block for the offline memory cache, keeping what the previous cache held
 * for every type the response does not carry.
 *
 * Response-wins where the response answers, previous-wins where it is silent. The point is
 * that a compact init stops erasing the offline cache: before this, going offline right after
 * a session start left `iron_rules: []` and no team standards at all, which is exactly what
 * the offline probe on 2026-08-10 returned.
 *
 * Known and deliberate: `principles` in a compact response are trimmed to id / title / code,
 * and they still overwrite the previous full copies. That is the pre-existing behaviour and it
 * is a different (smaller) problem — inferring "this looks truncated" from the absence of a
 * content field would be a guess, and a wrong guess here silently pins stale content.
 *
 * @param {object|null} previousData the `data` block of the cache on disk, if any
 * @param {object} response the init response
 * @param {Array<object>|null} rules rules resolved by pickRulesForCache, or null if unknown
 * @returns {object} a `data` block ready to write
 */
export function mergeOfflineCacheData(previousData, response, rules) {
  const prev = previousData && typeof previousData === 'object' ? previousData : {};
  const res = response && typeof response === 'object' ? response : {};
  const out = {};

  // profile is a single object in the response and a one-element array in the cache.
  if (res.profile) out.profile = [res.profile];
  else out.profile = Array.isArray(prev.profile) ? prev.profile : [];

  for (const [type, field] of Object.entries(OFFLINE_CACHE_FIELDS)) {
    if (type === 'iron_rule') {
      out.iron_rule = rules || (Array.isArray(prev.iron_rule) ? prev.iron_rule : []);
      continue;
    }
    const fromResponse = res[field];
    if (Array.isArray(fromResponse)) out[type] = fromResponse;
    else out[type] = Array.isArray(prev[type]) ? prev[type] : [];
  }

  return out;
}
