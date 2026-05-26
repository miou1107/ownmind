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
 *   1. IR-002 with a secret-detect hit  → mem_blocked_secret_regex
 *   2. Iron-rule quality lint failure  → mem_blocked_iron_rule_quality
 *   3. Any other block_on_fail rule    → clt_user_reported_other
 *   4. Empty / unknown                 → mem_iron_rule_blocking_commit_no_fingerprint
 */

describe('v1.26.8 — selectBlockFingerprint', () => {
  it('IR-002 secret-detect hit → mem_blocked_secret_regex (most specific)', () => {
    const reasons = [
      { ruleCode: 'IR-002', ruleTitle: 'do not commit secrets', secretHit: true },
    ];
    assert.equal(selectBlockFingerprint(reasons), 'mem_blocked_secret_regex');
  });

  it('IR-002 condition fail (no secret hit) → still secret category', () => {
    // Even without an inline secret-detect hit, IR-002 triggering means "secrets" topic.
    const reasons = [
      { ruleCode: 'IR-002', ruleTitle: 'do not commit secrets', secretHit: false },
    ];
    assert.equal(selectBlockFingerprint(reasons), 'mem_blocked_secret_regex');
  });

  it('iron-rule quality lint failure → mem_blocked_iron_rule_quality', () => {
    const reasons = [
      { ruleCode: 'IR-005', ruleTitle: 'iron-rule quality check', secretHit: false },
    ];
    assert.equal(selectBlockFingerprint(reasons), 'mem_blocked_iron_rule_quality');
  });

  it('other block_on_fail rule → clt_user_reported_other', () => {
    const reasons = [
      { ruleCode: 'IR-008', ruleTitle: 'sync README/CHANGELOG', secretHit: false },
    ];
    assert.equal(selectBlockFingerprint(reasons), 'clt_user_reported_other');
  });

  it('mixed reasons: secret + quality → secret wins (most specific)', () => {
    const reasons = [
      { ruleCode: 'IR-002', ruleTitle: 'do not commit secrets', secretHit: true },
      { ruleCode: 'IR-005', ruleTitle: 'iron-rule quality check', secretHit: false },
    ];
    assert.equal(selectBlockFingerprint(reasons), 'mem_blocked_secret_regex');
  });

  it('mixed reasons: quality + generic → quality wins over generic', () => {
    const reasons = [
      { ruleCode: 'IR-005', ruleTitle: 'iron-rule quality check', secretHit: false },
      { ruleCode: 'IR-008', ruleTitle: 'sync README/CHANGELOG', secretHit: false },
    ];
    assert.equal(selectBlockFingerprint(reasons), 'mem_blocked_iron_rule_quality');
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

  it('IR-003 (iron-rule quality family by name pattern) → quality fingerprint', () => {
    // The rule code prefix IR-### plus title hints aren't enough; we rely on
    // a known list of "quality-lint" rule codes (IR-005 etc.). IR-003 is a
    // different rule (reproduction-test rule), so it falls back to generic.
    const reasons = [
      { ruleCode: 'IR-003', ruleTitle: 'reproduction test before fix', secretHit: false },
    ];
    assert.equal(selectBlockFingerprint(reasons), 'clt_user_reported_other');
  });
});
