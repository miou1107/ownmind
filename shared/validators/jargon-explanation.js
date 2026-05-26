/**
 * v1.21.0: Jargon-quality validator.
 *
 * Detects "non-whitelisted English term appearing for the first time with no
 * plain-Chinese explanation within the next 80 characters."
 * Wraps the existing checkJargonExplanation pure function with the validator
 * interface.
 *
 * User enables via:
 *   { name: 'jargon_explanation', params: {} }
 *
 * params currently has no options; future candidates: window_chars,
 * extra_whitelist, etc.
 */

import { checkJargonExplanation } from '../language-lint.js';
import { LINT_JARGON_EXPLANATION_REQUIRED } from '../lint-event-types.js';

export const name = 'jargon_explanation';

/**
 * @param {string} content
 * @param {object} [params={}] - settings passed in via user metadata
 * @param {object} [context={}] - { historicalCorpus, userPrompts, ... }
 * @returns {{ ok: boolean, violation?: { event, message, detail } }}
 */
export function check(content, params = {}, context = {}) {
  const result = checkJargonExplanation(content, context.historicalCorpus || '');
  if (result.ok) return { ok: true };
  return {
    ok: false,
    violation: {
      event: LINT_JARGON_EXPLANATION_REQUIRED,
      message:
        `Jargon / technical terms missing plain-Chinese explanation — ${result.jargonWithoutExplanation.length} terms (${result.jargonWithoutExplanation.slice(0, 5).join(', ')}) lack a follow-up explanation within 50 characters (e.g. "（白話）", "：explanation", "即...")`,
      detail: { jargon: result.jargonWithoutExplanation },
    },
  };
}
