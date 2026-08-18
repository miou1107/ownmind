/**
 * v1.21.0: Mixed-Chinese/English ratio validator.
 *
 * Flags Chinese sentences whose English-word ratio exceeds a threshold.
 * The threshold can be configured per user via rule metadata.
 *
 * User enables via:
 *   { name: 'language_mixed_ratio', params: { threshold: 0.15 } }
 *
 * params:
 *   - threshold (number, default 0.15): upper bound for English ratio; anything
 *     above is considered a violation.
 */

import { checkMixedLanguage } from '../language-lint.js';
import { LINT_LANGUAGE_MIXED_RATIO } from '../lint-event-types.js';

export const name = 'language_mixed_ratio';

export function check(content, params = {}, _context = {}) {
  const threshold = typeof params.threshold === 'number' ? params.threshold : 0.15;
  const result = checkMixedLanguage(content, threshold);
  if (result.ok) return { ok: true };
  // messageKey/messageParams are what the banner renders; `message` stays English because it
  // is what the lint event and the compliance record carry, and those are read by the server
  // and by the model. See the header note in shared/validators/index.js.
  const messageParams = {
    ratio: (result.ratio * 100).toFixed(1),
    threshold: (threshold * 100).toFixed(0),
    count: result.mixedWords.length,
    words: result.mixedWords.slice(0, 5).join(', '),
  };
  return {
    ok: false,
    violation: {
      event: LINT_LANGUAGE_MIXED_RATIO,
      messageKey: 'lint.violation.languageMixedRatio',
      messageParams,
      message:
        `Mixed Chinese-English ratio ${messageParams.ratio}% > ${messageParams.threshold}% — found ${messageParams.count} non-whitelisted English words (first 5: ${messageParams.words}). Please use plain Chinese.`,
      detail: { ratio: result.ratio, mixedWords: result.mixedWords },
    },
  };
}
