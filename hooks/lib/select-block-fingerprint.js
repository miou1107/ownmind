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
 *   2. Iron-rule quality lint codes → mem_blocked_iron_rule_quality
 *   3. Any other rule → clt_user_reported_other
 *   4. Empty / malformed → placeholder fallback
 *
 * The placeholder is preserved as the last-resort fallback so behavior is
 * never worse than before this change.
 */

// v1.26.33: the secret category is keyed on the semantic signal carried in
// each reason (isSecretRule, set from the rule's verification shape, or a
// concrete secretHit), not on a personal iron-rule code.

// Iron-rule "quality lint" family — rules whose verification primarily checks
// the structure / contents of an iron-rule write (length, sections, etc.),
// not commit hygiene. Conservative list — anything not here falls back to generic.
const IRON_RULE_QUALITY_CODES = new Set([
  'IR-005',  // do not blind edit
  'IR-006',  // any new knowledge must propagate across all layers
  'IR-027',  // reminders are ineffective; logic is what works (the design rule itself)
]);

export function selectBlockFingerprint(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return 'mem_iron_rule_blocking_commit_no_fingerprint';
  }

  let hasSecret = false;
  let hasQuality = false;
  let hasOther = false;

  for (const r of reasons) {
    if (!r || typeof r !== 'object') continue;
    // Secret category is keyed on the de-identified semantic signal, so it is
    // checked before the (still code-based) quality family.
    if (r.isSecretRule === true || r.secretHit === true) {
      hasSecret = true;
      continue;
    }
    const code = typeof r.ruleCode === 'string' ? r.ruleCode : '';
    if (!code) {
      hasOther = true;
      continue;
    }
    if (IRON_RULE_QUALITY_CODES.has(code)) {
      hasQuality = true;
    } else {
      hasOther = true;
    }
  }

  if (hasSecret) return 'mem_blocked_secret_regex';
  if (hasQuality) return 'mem_blocked_iron_rule_quality';
  if (hasOther) return 'clt_user_reported_other';
  return 'mem_iron_rule_blocking_commit_no_fingerprint';
}
