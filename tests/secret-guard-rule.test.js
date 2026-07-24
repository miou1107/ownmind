import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isSecretGuardRule } from '../hooks/lib/secret-guard-rule.js';

/**
 * v1.26.33 — the pre-commit secret content scan must key on the semantic
 * identity of the secret-guard rule (the `commit_no_secrets` template's
 * `conditions.type === 'staged_files_exclude'`), NOT on one user's personal
 * iron-rule code `IR-002`. Otherwise the scan never runs for users whose
 * secret rule has a different number → secrets slip through.
 */
describe('v1.26.33 — isSecretGuardRule', () => {
  it('true when conditions.type is staged_files_exclude (any rule code)', () => {
    const verification = {
      trigger: ['commit'],
      conditions: { type: 'staged_files_exclude', params: { patterns: ['.env'] } },
    };
    assert.equal(isSecretGuardRule(verification), true);
  });

  it('does not depend on any personal iron-rule code', () => {
    // Same verification, no code anywhere — still recognized.
    const verification = { conditions: { type: 'staged_files_exclude' } };
    assert.equal(isSecretGuardRule(verification), true);
  });

  it('false for a different condition type (e.g. quality three-step)', () => {
    const verification = {
      conditions: { operator: 'AND', checks: [{ type: 'recent_event_exists' }] },
    };
    assert.equal(isSecretGuardRule(verification), false);
  });

  it('false / safe for missing or malformed verification', () => {
    assert.equal(isSecretGuardRule(null), false);
    assert.equal(isSecretGuardRule(undefined), false);
    assert.equal(isSecretGuardRule({}), false);
    assert.equal(isSecretGuardRule({ conditions: null }), false);
  });
});
