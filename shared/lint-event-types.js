/**
 * v1.20.4：Lint 事件常數模組
 *
 * 用途：
 *   把 lint 鉤子判斷的「事件」跟「個人鐵律編號」解耦。產品程式碼一律用中性事件常數、
 *   不寫死任何 user 的個人鐵律編號（避免違反 IR-050、白話：個人鐵律編號不能寫進產品碼）。
 *
 * 「事件 → 個人鐵律編號」對應靠規則快取（白話：user 自己的鐵律 metadata）內
 * `triggered_by_event` 欄位查表、由 `buildComplianceEvents` 等 caller 處理。
 *
 * 零外部依賴、純常數模組。
 */

/**
 * 中英混雜比例過高
 * （之前寫死成「IR-037」、現在中性化）
 */
export const LINT_LANGUAGE_MIXED_RATIO = 'lint_language_mixed_ratio';

/**
 * 行話 / 專有名詞沒附白話說明
 * （之前寫死成「IR-036」、現在中性化）
 */
export const LINT_JARGON_EXPLANATION_REQUIRED = 'lint_jargon_explanation_required';

/**
 * 隱私內容偵測（電子郵件 / 身分證 / 手機號碼等）
 * v1.19.10 中性化、已不是個人鐵律編號、本檔記錄供查表用
 */
export const LINT_PRIVACY_CHECK = 'privacy_check';

/**
 * 事件常數 → 中文事件名（給 user-facing 訊息渲染用）
 *
 * 規則：不冠任何 IR-XXX 編號、純中性中文描述。
 */
export const EVENT_DISPLAY_NAMES = {
  [LINT_LANGUAGE_MIXED_RATIO]: 'Mixed Chinese-English',
  [LINT_JARGON_EXPLANATION_REQUIRED]: 'Jargon quality',
  [LINT_PRIVACY_CHECK]: 'Privacy content',
};

/**
 * 拿事件常數對應的顯示名。未知事件 → 原樣回傳。
 *
 * @param {string} eventCode
 * @returns {string}
 */
export function getEventDisplayName(eventCode) {
  return EVENT_DISPLAY_NAMES[eventCode] || eventCode;
}

/**
 * 全部已知事件常數的陣列（給測試 / 工具列舉用）
 */
export const ALL_LINT_EVENTS = [
  LINT_LANGUAGE_MIXED_RATIO,
  LINT_JARGON_EXPLANATION_REQUIRED,
  LINT_PRIVACY_CHECK,
];

/**
 * 從 user 規則快取找對應「事件常數」的個人鐵律編號。
 *
 * 規則需要在 metadata.triggered_by_event 宣告對應事件。找不到回 null。
 *
 * @param {Array<object>} rules — iron rules cache 內容（白話：user 個人鐵律陣列）
 * @param {string} eventCode — 事件常數
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
