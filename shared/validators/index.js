/**
 * v1.21.0: Validator registry.
 *
 * Centralizes the built-in validator modules and exposes a unified lookup API.
 * Core of the rule-driven lint pipeline: the lint hook reads
 * `metadata.lint_validator.name` on the user's iron rule and resolves it here
 * to the matching validator's check function.
 *
 * Adding a new validator:
 *   1. Add a module under this directory exporting { name, check }
 *   2. Register it in VALIDATOR_REGISTRY below
 *   3. Document it
 *   4. Give its violation a `messageKey` + `messageParams`, and add that key to all three
 *      hooks/locales dictionaries — see below.
 *
 * Why a violation carries a key and not just a sentence
 * -----------------------------------------------------
 * A violation is read by two audiences with opposite needs. The user reads it in a banner, in
 * their own language. The server and the model read it in the lint event and the compliance
 * record, where English is the policy (hooks/lib/i18n.js states it: model-facing strings stay
 * English, only audience=user strings go through t()).
 *
 * So each violation carries both: `message` is the English sentence, unchanged, and
 * `messageKey`/`messageParams` are what hooks/ownmind-reply-lint.js renders for the human.
 * Until v1.30.15 only `message` existed, and `lint.banner.violationLine` — the "  ・{rule}:
 * {message}" frame — interpolated it verbatim, so a Chinese banner arrived wrapped around an
 * English sentence. On the mixed-language rule specifically, the product broke the rule it was
 * reporting.
 *
 * A missing dictionary entry does NOT fall back to English: `t()` returns the key itself, so
 * `lint.violation.somethingNew` would be printed to a user. tests/lint-violation-message-i18n
 * asserts every registered validator's key exists in en/zh/ja and that the English rendering
 * still equals `message` byte for byte.
 */

import * as jargon from './jargon-explanation.js';
import * as mixed from './language-mixed-ratio.js';
import * as privacy from './privacy-detect.js';

/**
 * Validator registry: name → module.
 */
export const VALIDATOR_REGISTRY = {
  [jargon.name]: jargon,
  [mixed.name]: mixed,
  [privacy.name]: privacy,
};

/**
 * Look up a validator module by name. Returns null when not found.
 * @param {string} validatorName
 * @returns {{name: string, check: Function} | null}
 */
export function findValidator(validatorName) {
  if (!validatorName || typeof validatorName !== 'string') return null;
  return VALIDATOR_REGISTRY[validatorName] || null;
}

/**
 * List all available validator names (for the user dashboard / docs).
 * @returns {string[]}
 */
export function listAvailableValidators() {
  return Object.keys(VALIDATOR_REGISTRY);
}

/**
 * Extract all enabled validators from the user's iron-rule cache.
 *
 * Each rule may carry `metadata.lint_validator: { name, params }` — if present,
 * the validator is enabled. The same validator name can be enabled by multiple
 * rules, and all of them are returned (one reply can violate via several rules).
 *
 * @param {Array<object>} rules - iron rules cache contents
 * @returns {Array<{rule: string, validator: string, params: object}>}
 */
export function extractEnabledValidators(rules) {
  if (!Array.isArray(rules)) return [];
  const enabled = [];
  for (const rule of rules) {
    const lv = rule?.metadata?.lint_validator;
    if (!lv || typeof lv !== 'object') continue;
    if (typeof lv.name !== 'string' || !lv.name) continue;
    enabled.push({
      rule: rule.code || '',
      validator: lv.name,
      params: lv.params || {},
    });
  }
  return enabled;
}
