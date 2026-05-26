/**
 * v1.21.0：中英混雜比例 validator
 *
 * 偵測「中文句子裡英文詞比例超過閾值」、可由 user metadata 調整 threshold。
 *
 * user 啟用：
 *   { name: 'language_mixed_ratio', params: { threshold: 0.15 } }
 *
 * params:
 *   - threshold (number、預設 0.15)：中英混雜比例上限、超過視為違反
 */

import { checkMixedLanguage } from '../language-lint.js';
import { LINT_LANGUAGE_MIXED_RATIO } from '../lint-event-types.js';

export const name = 'language_mixed_ratio';

export function check(content, params = {}, _context = {}) {
  const threshold = typeof params.threshold === 'number' ? params.threshold : 0.15;
  const result = checkMixedLanguage(content, threshold);
  if (result.ok) return { ok: true };
  return {
    ok: false,
    violation: {
      event: LINT_LANGUAGE_MIXED_RATIO,
      message:
        `Mixed Chinese-English ratio ${(result.ratio * 100).toFixed(1)}% > ${(threshold * 100).toFixed(0)}% — found ${result.mixedWords.length} non-whitelisted English words (first 5: ${result.mixedWords.slice(0, 5).join(', ')}). Please use plain Chinese.`,
      detail: { ratio: result.ratio, mixedWords: result.mixedWords },
    },
  };
}
