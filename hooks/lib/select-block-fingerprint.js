/**
 * v1.26.8 — select a bug-report fingerprint based on which rule(s) blocked the commit.
 *
 * Bug-report id=4 (2026-05-26): the pre-commit hook used to hard-code
 * `mem_iron_rule_blocking_commit_no_fingerprint` for every block. Prod's
 * server-side fingerprint registry has not synced past v1.26.0 yet, so
 * ownmind_report_bug calls with the placeholder fingerprint return 400.
 *
 * Dispatch (most-specific wins):
 *   1. Secret-guard rule / secret hit → mem_blocked_secret_regex
 *   2. Any other blocking rule → clt_user_reported_other
 *   3. Empty / malformed → placeholder fallback
 *
 * The placeholder is preserved as the last-resort fallback so behavior is
 * never worse than before this change.
 */

// v1.26.33: the secret category is keyed on the semantic signal carried in
// each reason (isSecretRule, set from the rule's verification shape, or a
// concrete secretHit), not on a personal iron-rule code.
//
// v1.26.34: removed the personal-code "quality lint" heuristic (a hardcoded
// list of individual rule numbers). Those rules carry no commit-triggered
// verification, so that branch was unreachable, and the list did not match the
// actual commit-time quality-process rule anyway. Quality-process blocks now
// bucket as the generic category.

export function selectBlockFingerprint(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return 'mem_iron_rule_blocking_commit_no_fingerprint';
  }

  let hasSecret = false;
  let hasOther = false;

  for (const r of reasons) {
    if (!r || typeof r !== 'object') continue;
    // Secret category is keyed on the de-identified semantic signal.
    if (r.isSecretRule === true || r.secretHit === true) {
      hasSecret = true;
      continue;
    }
    hasOther = true;
  }

  if (hasSecret) return 'mem_blocked_secret_regex';
  if (hasOther) return 'clt_user_reported_other';
  return 'mem_iron_rule_blocking_commit_no_fingerprint';
}
