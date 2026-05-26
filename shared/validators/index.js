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
