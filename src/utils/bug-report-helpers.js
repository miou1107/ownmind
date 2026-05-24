/**
 * bug-report-helpers — v1.19.14 錯誤回報工具用的純函式 helpers
 *
 * 對應 OpenSpec 提案 v1.19.14-bug-report-tool（規格 §2.5、§2.7、§五、§六）。
 *
 * 設計重點：
 *   - 純函式（不直接動 req / res）、由 route handler 呼叫
 *   - 跟 DB 互動的函式都吃外部傳入的 query function（測試好 mock）
 *   - 旗標附加邏輯統一在這、避免散落多個 route 拼錯
 */

import { isValidFingerprint } from '../../shared/bug-fingerprints.js';

/**
 * 驗 confirm_string 必須是字串「送出」（v4 設計、後端守門）
 *
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateConfirmString(value) {
  if (typeof value !== 'string') {
    return { ok: false, error: '需要使用者親口輸入「送出」才能建立回報' };
  }
  if (value !== '送出') {
    return { ok: false, error: '需要使用者親口輸入「送出」才能建立回報' };
  }
  return { ok: true };
}

/**
 * 把 suggest_report 旗標加到既有的錯誤 body
 *
 * @param {Object} body - 原本要回給 client 的 JSON body
 * @param {string} fingerprint - 註冊過的指紋
 * @param {Object} [options]
 * @param {string} [options.hint] - 客製提示文字（覆寫預設）
 * @returns {Object} 加完旗標的新 body
 */
export function withReportSuggestion(body, fingerprint, options = {}) {
  if (!isValidFingerprint(fingerprint)) {
    throw new Error(
      `withReportSuggestion：未註冊或 invalid 的指紋「${fingerprint}」、請先在 shared/bug-fingerprints.js 註冊`
    );
  }
  const hint = options.hint || '你覺得不該被擋？回報給開發者';
  return {
    ...body,
    suggest_report: true,
    bug_fingerprint: fingerprint,
    report_hint: hint,
  };
}

/**
 * 查使用者是否在 24h spam 封鎖期內
 *
 * @param {Function} query - DB 查詢函式 (text, params) => Promise<{ rows }>
 * @param {number} userId
 * @returns {Promise<boolean>}
 */
export async function isUserInSpamBlock(query, userId) {
  const result = await query(
    `SELECT 1 FROM bug_report_spam_blocks
      WHERE user_id = $1 AND blocked_until > now()
      LIMIT 1`,
    [userId]
  );
  return result.rows.length > 0;
}

/**
 * 查使用者過去 24h 是否拒絕過該指紋（冷靜期）
 *
 * @param {Function} query
 * @param {number} userId
 * @param {string} fingerprint
 * @returns {Promise<boolean>}
 */
export async function hasDeclinedRecently(query, userId, fingerprint) {
  const result = await query(
    `SELECT 1 FROM bug_report_declines
      WHERE user_id = $1
        AND bug_fingerprint = $2
        AND declined_at > now() - INTERVAL '24 hours'
      LIMIT 1`,
    [userId, fingerprint]
  );
  return result.rows.length > 0;
}

/**
 * 計使用者過去 1h 內同 fingerprint 的回報筆數
 *
 * @param {Function} query
 * @param {number} userId
 * @param {string} fingerprint
 * @returns {Promise<number>}
 */
export async function countSameFingerprintInLastHour(query, userId, fingerprint) {
  const result = await query(
    `SELECT COUNT(*)::text AS count FROM bug_reports
      WHERE user_id = $1
        AND bug_fingerprint = $2
        AND created_at > now() - INTERVAL '1 hour'`,
    [userId, fingerprint]
  );
  return parseInt(result.rows[0]?.count || '0', 10);
}

/**
 * 判斷是否該因「同指紋 1h 內已 3 筆」直接 429 擋下
 * （介面層第一道防線、避免 AI 腦補狂送同樣的錯）
 *
 * @param {Function} query
 * @param {number} userId
 * @param {string} fingerprint
 * @returns {Promise<{ reject: boolean, message?: string, current_count?: number }>}
 */
export async function shouldRejectByFingerprintRateLimit(query, userId, fingerprint) {
  const count = await countSameFingerprintInLastHour(query, userId, fingerprint);
  if (count >= 3) {
    return {
      reject: true,
      message: '同類錯誤回報太頻繁、請稍後再試（1 小時內已收 3 筆）',
      current_count: count,
    };
  }
  return { reject: false, current_count: count };
}

/**
 * 綜合判斷：要不要在錯誤回應中附 suggest_report 旗標
 * 需通過：未在 spam 封鎖期 AND 過去 24h 未拒絕過該指紋
 *
 * @param {Function} query
 * @param {number} userId
 * @param {string} fingerprint
 * @returns {Promise<boolean>}
 */
export async function isSuggestReportEligible(query, userId, fingerprint) {
  const [inBlock, declined] = await Promise.all([
    isUserInSpamBlock(query, userId),
    hasDeclinedRecently(query, userId, fingerprint),
  ]);
  return !inBlock && !declined;
}
