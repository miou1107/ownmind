/**
 * v1.21.0：隱私偵測 validator
 *
 * 包裝既有 detectPrivacyLeak（白話：偵測電子郵件 / 身分證 / 手機號碼之類）。
 * user 啟用：
 *   { name: 'privacy_detect', params: {} }
 *
 * context:
 *   - userPrompts (array)：使用者最近的提問、含相同個資不算外洩（user 自己提到的）
 */

import { detectPrivacyLeak } from '../privacy-detect.js';
import { LINT_PRIVACY_CHECK } from '../lint-event-types.js';

export const name = 'privacy_detect';

function formatPrivacySummary(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return '無';
  const byType = {};
  for (const m of matches) {
    byType[m.type] = (byType[m.type] || 0) + 1;
  }
  return Object.entries(byType)
    .map(([type, count]) => `${type}×${count}`)
    .join('、');
}

export function check(content, _params = {}, context = {}) {
  const userPrompts = Array.isArray(context.userPrompts) ? context.userPrompts : [];
  const result = detectPrivacyLeak(content, { userPrompts });
  if (!result.detected) return { ok: true };
  return {
    ok: false,
    violation: {
      event: LINT_PRIVACY_CHECK,
      message: `回應疑似含使用者隱私（${formatPrivacySummary(result.matches)}）。請改寫掉那段或改用代稱（例：「[email]」「[手機號碼]」）`,
      detail: { matches: result.matches },
    },
  };
}
