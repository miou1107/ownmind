/**
 * v1.26.124 — which iron rules belong in ~/.ownmind/cache/iron_rules.json.
 *
 * The cache was built as "the verifiable rules": everything carrying
 * `metadata.verification`, for the commit-time verification engine. Then v1.21.0 added a
 * second consumer with a different need — the reply-lint Stop hook reads the same file and
 * looks for `metadata.lint_validator` to decide which reply checks are enabled.
 *
 * Nobody widened the filter. So a rule carrying `lint_validator` and no `verification` was
 * fetched from the server, dropped on the way to disk, and the Stop hook resolved zero
 * validators from a cache that could never contain it. Configuring the check did nothing,
 * silently, and the hook still exited 0 — indistinguishable from a reply with no problems.
 *
 * Two programs write this file (the MCP at init, and the pre-commit hook when it finds the
 * cache empty), so the predicate lives here rather than in either of them: while they
 * disagreed, whichever wrote last decided what the other could see.
 */

/**
 * True when some consumer of the rule cache needs this rule.
 *
 * @param {object} rule
 * @returns {boolean}
 */
export function isCacheableRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  const meta = rule.metadata;
  if (!meta || typeof meta !== 'object') return false;
  // verification -> the commit-time engine; lint_validator -> the reply-lint Stop hook.
  return Boolean(meta.verification) || Boolean(meta.lint_validator);
}

/**
 * @param {Array<object>} rules
 * @returns {Array<object>} the subset worth caching, in the order given
 */
export function filterCacheableRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.filter(isCacheableRule);
}
