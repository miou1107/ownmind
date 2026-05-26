/**
 * v1.21.0: Privacy validator.
 *
 * Wraps the existing detectPrivacyLeak (detects email addresses, Taiwan ID
 * numbers, mobile phone numbers, etc.).
 *
 * User enables via:
 *   { name: 'privacy_detect', params: {} }
 *
 * context:
 *   - userPrompts (array): user's recent prompts — values they themselves typed
 *     are not counted as leaks.
 */

import { detectPrivacyLeak } from '../privacy-detect.js';
import { LINT_PRIVACY_CHECK } from '../lint-event-types.js';

export const name = 'privacy_detect';

function formatPrivacySummary(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return 'none';
  const byType = {};
  for (const m of matches) {
    byType[m.type] = (byType[m.type] || 0) + 1;
  }
  return Object.entries(byType)
    .map(([type, count]) => `${type}×${count}`)
    .join(', ');
}

export function check(content, _params = {}, context = {}) {
  const userPrompts = Array.isArray(context.userPrompts) ? context.userPrompts : [];
  const result = detectPrivacyLeak(content, { userPrompts });
  if (!result.detected) return { ok: true };
  return {
    ok: false,
    violation: {
      event: LINT_PRIVACY_CHECK,
      message: `The response appears to contain user privacy data (${formatPrivacySummary(result.matches)}). Rewrite that segment using placeholders like "[email]" or "[mobile phone]".`,
      detail: { matches: result.matches },
    },
  };
}
