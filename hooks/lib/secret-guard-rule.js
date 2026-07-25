/**
 * v1.26.33: identify the "secret guard" iron rule by its semantic verification
 * shape rather than by a personal iron-rule code.
 *
 * The secret-guard rule gets its verification from the `commit_no_secrets`
 * template (src/utils/templates.js), whose `conditions.type` is
 * `staged_files_exclude`. That signal is stored on every matched rule and is
 * keyed by template identity, not by a user's rule number — so keying on it
 * works for every user (previously the pre-commit content scan was keyed on
 * the personal secret-rule code, which silently disabled the scan for anyone whose
 * secret rule had a different number).
 *
 * Zero external deps, pure function.
 */

const SECRET_GUARD_CONDITION_TYPE = 'staged_files_exclude';

/**
 * Note: matches the leaf shape the `commit_no_secrets` template emits
 * (`conditions.type` at the top level). A hand-authored rule that nested the
 * exclude under a composite (`conditions.operator: 'AND', checks: [...]`) would
 * not match here and would get no content scan — filename-exclude still blocks
 * via evaluateConditions' recursion. Revisit if custom verifications are added.
 *
 * @param {object} verification — a rule's `metadata.verification` block
 * @returns {boolean} true if this is the secret-guard rule
 */
export function isSecretGuardRule(verification) {
  return verification?.conditions?.type === SECRET_GUARD_CONDITION_TYPE;
}
