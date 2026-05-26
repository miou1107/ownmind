/**
 * v1.21.0：行話品質 validator
 *
 * 偵測「非白名單英文詞第一次出現時、後面 80 字內沒附白話說明」。
 * 包裝既有 checkJargonExplanation 純函式邏輯、加上 validator 介面。
 *
 * user 在自己的鐵律 metadata.lint_validator 啟用：
 *   { name: 'jargon_explanation', params: {} }
 *
 * params 目前無設定項、未來可加：window_chars / extra_whitelist 等。
 */

import { checkJargonExplanation } from '../language-lint.js';
import { LINT_JARGON_EXPLANATION_REQUIRED } from '../lint-event-types.js';

export const name = 'jargon_explanation';

/**
 * @param {string} content
 * @param {object} [params={}] - user metadata 帶進來的設定
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
        `行話 / 專有名詞沒附白話說明 — ${result.jargonWithoutExplanation.length} 個詞（${result.jargonWithoutExplanation.slice(0, 5).join(', ')}）後面 50 字內沒有「（白話）」「：解釋」「即...」之類補充`,
      detail: { jargon: result.jargonWithoutExplanation },
    },
  };
}
