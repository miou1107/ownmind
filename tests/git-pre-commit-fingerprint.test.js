import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectBlockFingerprint } from '../hooks/lib/select-block-fingerprint.js';

/**
 * v1.26.8 — pre-commit hook dynamic fingerprint dispatch
 *
 * Bug report id=4 (2026-05-26): the hook hard-coded `mem_iron_rule_blocking_commit_no_fingerprint`
 * as the bug-report fingerprint for every block. Prod's server-side fingerprint
 * registry has not synced past v1.26.0 yet, so calls to ownmind_report_bug get
 * 400 "must be a server-registered fingerprint". Fix: dispatch the fingerprint
 * by which rule actually blocked.
 *
 * Dispatch table (most-specific wins, in this order):
 *   1. Secret-guard rule (semantic) or secret-detect hit → mem_blocked_secret_regex
 *   2. Iron-rule quality lint failure  → mem_blocked_iron_rule_quality
 *   3. Any other block_on_fail rule    → clt_user_reported_other
 *   4. Empty / unknown                 → mem_iron_rule_blocking_commit_no_fingerprint
 *
 * v1.26.33: the secret category is keyed on the de-identified `isSecretRule` /
 * `secretHit` signals, not on the personal code IR-002.
 */

describe('v1.26.8 — selectBlockFingerprint', () => {
  it('secret-detect hit → mem_blocked_secret_regex (most specific)', () => {
    const reasons = [
      { ruleCode: 'IR-002', ruleTitle: 'do not commit secrets', isSecretRule: true, secretHit: true },
    ];
    assert.equal(selectBlockFingerprint(reasons), 'mem_blocked_secret_regex');
  });

  it('secret-guard rule, condition fail (no inline hit) → still secret category', () => {
    // The secret-guard rule triggering means "secrets" topic even without an
    // inline detectSecretLike hit — keyed on isSecretRule, not a rule code.
    const reasons = [
      { ruleCode: 'IR-002', ruleTitle: 'do not commit secrets', isSecretRule: true, secretHit: false },
    ];
    assert.equal(selectBlockFingerprint(reasons), 'mem_blocked_secret_regex');
  });

  it('non-IR-002 secret-guard rule → still secret category (de-identified)', () => {
    const reasons = [
      { ruleCode: 'IR-099', ruleTitle: "this user's secret rule", isSecretRule: true, secretHit: false },
    ];
    assert.equal(selectBlockFingerprint(reasons), 'mem_blocked_secret_regex');
  });

  it('v1.26.34: a non-secret blocking rule → clt_user_reported_other (quality heuristic removed)', () => {
    // The personal-code "quality" category was removed in v1.26.34; a non-secret
    // block now buckets as the generic category regardless of the rule.
    const reasons = [
      { ruleCode: 'IR-005', ruleTitle: 'some blocking rule', secretHit: false },
    ];
    assert.equal(selectBlockFingerprint(reasons), 'clt_user_reported_other');
  });

  it('other block_on_fail rule → clt_user_reported_other', () => {
    const reasons = [
      { ruleCode: 'IR-008', ruleTitle: 'sync README/CHANGELOG', secretHit: false },
    ];
    assert.equal(selectBlockFingerprint(reasons), 'clt_user_reported_other');
  });

  it('mixed reasons: secret + non-secret → secret wins (most specific)', () => {
    const reasons = [
      { ruleCode: 'IR-002', ruleTitle: 'do not commit secrets', isSecretRule: true, secretHit: true },
      { ruleCode: 'IR-005', ruleTitle: 'some blocking rule', secretHit: false },
    ];
    assert.equal(selectBlockFingerprint(reasons), 'mem_blocked_secret_regex');
  });

  it('empty reasons → placeholder fallback', () => {
    assert.equal(selectBlockFingerprint([]),
      'mem_iron_rule_blocking_commit_no_fingerprint');
  });

  it('null reasons → placeholder fallback (defensive)', () => {
    assert.equal(selectBlockFingerprint(null),
      'mem_iron_rule_blocking_commit_no_fingerprint');
  });

  it('undefined reasons → placeholder fallback', () => {
    assert.equal(selectBlockFingerprint(undefined),
      'mem_iron_rule_blocking_commit_no_fingerprint');
  });

  it('reason with malformed shape → treated as generic (defensive)', () => {
    const reasons = [{ /* no ruleCode */ }];
    assert.equal(selectBlockFingerprint(reasons), 'clt_user_reported_other');
  });

  it('a non-secret rule with a code but no secret signal → generic', () => {
    // Fingerprint dispatch no longer inspects rule codes at all (v1.26.34);
    // only the secret signal is special-cased. Everything else is generic.
    const reasons = [
      { ruleCode: 'IR-003', ruleTitle: 'reproduction test before fix', secretHit: false },
    ];
    assert.equal(selectBlockFingerprint(reasons), 'clt_user_reported_other');
  });
});
