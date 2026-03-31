/**
 * OwnMind Verification Engine
 *
 * 純函式模組，零外部依賴，不綁定任何執行環境。
 * 被 git hook（L1/L5）、PreToolUse hook（L2）、MCP（L3）三處共用。
 *
 * 核心 API：
 *   evaluateConditions(conditions, context) → { pass: boolean, failures: string[] }
 *
 * 四大核心理念：
 *   1. 永不信賴 LLM — 由 harness 層級呼叫，非 AI 自主呼叫
 *   2. 不依賴單一機制 — 同一引擎被三處共用
 *   3. 裝後即忘 — 自動從快取讀取規則
 *   4. 事後補救 — 失敗記錄用於升級警告
 */

// ============================================================
// Simple glob matcher (避免外部依賴 minimatch)
// 支援 * (單層) 和 ** (跨目錄)
// ============================================================

function globMatch(file, pattern) {
  // 完全相等
  if (file === pattern) return true;

  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape 特殊字元（保留 * 和 ?）
    .replace(/\*\*/g, '§§')               // 暫存 **
    .replace(/\*/g, '[^/]*')              // * = 單層
    .replace(/§§/g, '.*')                 // ** = 跨目錄
    .replace(/\?/g, '[^/]');              // ? = 單一字元

  return new RegExp(`^${regex}$`).test(file);
}

// ============================================================
// CHECK_HANDLERS — 每個檢查類型一個純函式
// ============================================================

const CHECK_HANDLERS = {
  /**
   * staged 檔案必須包含指定 pattern
   * context 缺失 stagedFiles → return true（跳過檢查）
   */
  staged_files_include: (params, ctx) => {
    if (!ctx.stagedFiles) return true;
    const missing = params.patterns.filter(p =>
      !ctx.stagedFiles.some(f => globMatch(f, p))
    );
    return missing.length === 0;
  },

  /**
   * staged 檔案不能包含指定 pattern
   * context 缺失 → return true
   */
  staged_files_exclude: (params, ctx) => {
    if (!ctx.stagedFiles) return true;
    const found = params.patterns.filter(p =>
      ctx.stagedFiles.some(f => globMatch(f, p))
    );
    return found.length === 0;
  },

  /**
   * commit message 必須包含指定文字（任一匹配即可）
   * context 缺失 → return true
   */
  commit_message_contains: (params, ctx) => {
    if (!ctx.commitMessage) return true;
    return params.patterns.some(p => ctx.commitMessage.includes(p));
  },

  /**
   * commit message 不能包含指定文字
   * context 缺失 → return true
   */
  commit_message_not_contains: (params, ctx) => {
    if (!ctx.commitMessage) return true;
    return !params.patterns.some(p => ctx.commitMessage.includes(p));
  },

  /**
   * session 內必須有某個 comply 記錄
   * context 缺失 complianceEvents → return true（跳過，讓其他層補檢查）
   */
  recent_event_exists: (params, ctx) => {
    if (!ctx.complianceEvents) return true;
    return ctx.complianceEvents.some(e =>
      e.event === params.event && e.action === params.action
    );
  },

  /**
   * 特定原始碼是否被修改
   * context 缺失 → return false（語義：「有原始碼被改嗎？」不確定時不觸發）
   */
  source_files_changed: (params, ctx) => {
    if (!ctx.changedSourceFiles) return false;
    return params.patterns.some(p =>
      ctx.changedSourceFiles.some(f => globMatch(f, p))
    );
  }
};

// ============================================================
// evaluateConditions — 遞迴評估條件樹
// ============================================================

/**
 * 評估 verification 條件
 *
 * 支援三種節點：
 *   1. 葉節點 — { type, params, message }
 *   2. 組合節點 — { operator: "AND"|"OR", checks: [...] }
 *   3. 條件式 — { when: {...}, then: {...} }
 *
 * @param {object} conditions - verification.conditions 區塊
 * @param {object} context - 執行環境提供的資料
 * @returns {{ pass: boolean, failures: string[] }}
 */
function evaluateConditions(conditions, context) {
  // when/then 條件式
  if (conditions.when) {
    const whenResult = evaluateConditions(conditions.when, context);
    if (!whenResult.pass) {
      // when 為 false → 條件不適用 → pass
      return { pass: true, failures: [] };
    }
    // when 為 true → 評估 then
    return evaluateConditions(conditions.then, context);
  }

  // 葉節點：單一檢查
  if (conditions.type) {
    const handler = CHECK_HANDLERS[conditions.type];
    if (!handler) return { pass: true, failures: [] }; // 未知類型安全跳過
    const pass = handler(conditions.params, context);
    return { pass, failures: pass ? [] : [conditions.message || conditions.type] };
  }

  // 組合節點：AND / OR
  if (!conditions.checks || !Array.isArray(conditions.checks)) {
    return { pass: true, failures: [] }; // 無效結構安全跳過
  }

  const results = conditions.checks.map(c => evaluateConditions(c, context));

  if (conditions.operator === 'OR') {
    const allFail = results.every(r => !r.pass);
    return { pass: !allFail, failures: allFail ? results.flatMap(r => r.failures) : [] };
  }

  // 預設 AND（包含未指定 operator 的情況）
  const failures = results.flatMap(r => r.failures);
  return { pass: failures.length === 0, failures };
}

// ============================================================
// Exports
// ============================================================

export { evaluateConditions, CHECK_HANDLERS, globMatch };
