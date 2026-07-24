/**
 * v1.20.4: Lint event constants module.
 *
 * Purpose:
 *   Decouples the lint hooks' "event" from any specific user's iron-rule code.
 *   Product code uses neutral event constants and never hardcodes a user's
 *   personal iron-rule code (avoids IR-050: "personal iron-rule codes must not
 *   appear in product code").
 *
 * The "event → iron-rule code" mapping is resolved at lookup time from the
 * rule cache (the user's iron-rule metadata) via the `triggered_by_event`
 * field, handled by callers such as `buildComplianceEvents`.
 *
 * Zero external deps, pure constants module.
 */

/**
 * Mixed Chinese/English ratio too high.
 * (Previously hardcoded to "IR-037"; now neutral.)
 */
export const LINT_LANGUAGE_MIXED_RATIO = 'lint_language_mixed_ratio';

/**
 * Jargon / technical term missing a plain-Chinese explanation.
 * (Previously hardcoded to "IR-036"; now neutral.)
 */
export const LINT_JARGON_EXPLANATION_REQUIRED = 'lint_jargon_explanation_required';

/**
 * Privacy content detector (email / Taiwan ID / mobile phone, etc.).
 * Neutralized in v1.19.10; no longer tied to a personal iron-rule code.
 * Recorded here for lookup purposes.
 */
export const LINT_PRIVACY_CHECK = 'privacy_check';

/**
 * Full-layer sync on rule change — the compliance observability trigger fired
 * when a user saves / disables / updates an iron rule (the system observed a
 * rule mutation; cross-layer sync is expected but not proven).
 *
 * Not a lint violation, but it lives here because this module is the single
 * registry that decouples compliance events from any specific user's iron-rule
 * code. (Neutralized in v1.26.32; previously tied to a personal rule code.)
 */
export const RULE_FULL_LAYER_SYNC = 'rule_full_layer_sync';

/**
 * Event constant → display name (for rendering user-facing messages).
 *
 * Rule: no IR-XXX codes; purely neutral descriptions.
 */
export const EVENT_DISPLAY_NAMES = {
  [LINT_LANGUAGE_MIXED_RATIO]: 'Mixed Chinese-English',
  [LINT_JARGON_EXPLANATION_REQUIRED]: 'Jargon quality',
  [LINT_PRIVACY_CHECK]: 'Privacy content',
  [RULE_FULL_LAYER_SYNC]: 'Full-layer sync on rule change',
};

/**
 * Resolve an event constant to its display name. Unknown events are
 * returned unchanged.
 *
 * @param {string} eventCode
 * @returns {string}
 */
export function getEventDisplayName(eventCode) {
  return EVENT_DISPLAY_NAMES[eventCode] || eventCode;
}

/**
 * All known event constants (for tests / tooling enumeration).
 */
export const ALL_LINT_EVENTS = [
  LINT_LANGUAGE_MIXED_RATIO,
  LINT_JARGON_EXPLANATION_REQUIRED,
  LINT_PRIVACY_CHECK,
  RULE_FULL_LAYER_SYNC,
];

/**
 * Look up the user's iron-rule that corresponds to a given event constant.
 *
 * The rule must declare the matching event in metadata.triggered_by_event;
 * returns null if no match.
 *
 * @param {Array<object>} rules — iron rules cache contents (the user's iron rules)
 * @param {string} eventCode — event constant
 * @returns {{ code: string, title: string } | null}
 */
export function findUserRuleByEvent(rules, eventCode) {
  if (!Array.isArray(rules) || !eventCode) return null;
  for (const rule of rules) {
    const triggered = rule?.metadata?.triggered_by_event;
    if (triggered === eventCode) {
      return {
        code: rule.code || '',
        title: rule.title || '',
      };
    }
  }
  return null;
}
