/**
 * safety-detect.js — v1.18.9 4 種安全告警偵測（純函式）
 *
 * 設計來源：openspec/changes/v1.18.5-block-feedback-and-safety-alerts/spec.md B
 *
 * 為什麼純函式：
 *   - 偵測規則不依賴資料庫 / express req-res
 *   - 由各 wire 點（routes / 中間攔截程式 / 後台工作）呼叫
 *   - 好測試、好 reuse
 *
 * 4 種偵測：
 *   1. detectCrossUserAccess — 回傳資料含別人的記憶
 *   2. detectPrivateMemoryLeak — 同上但語意是「私人類型外洩」（未來可細化）
 *   3. detectSecretInLogs — 日誌訊息含機密金鑰原文
 *   4. detectBulkRead — 1h 內讀超過閾值
 *
 * 寫紀錄到 usage_audit_log 由 src/utils/safety-audit.js 處理（caller 拿到偵測結果後呼叫）。
 */

export const SAFETY_ALERT_TYPES = Object.freeze([
  'cross_user_access',
  'private_memory_leak',
  'secret_value_in_logs',
  'bulk_read_alert',
]);

// 拍板決策 4：單 user / api_key 1h 內讀取 > 1000 筆
export const BULK_READ_THRESHOLD = 1000;
export const BULK_READ_WINDOW_HOURS = 1;

// 機密金鑰短於此長度不檢查（避免 false positive、例如「1234」太常見）
const SECRET_MIN_LENGTH = 8;

/**
 * 偵測「回傳資料含別人的記憶」
 *
 * @param {number} reqUserId - 請求者 user_id
 * @param {Array<{user_id: number}>} returnedItems - 回傳的記憶集合
 * @returns {null | {offending_user_ids: number[], count: number}}
 *   null = 沒違規；有值 = 有違規、details 給 writeSafetyAudit
 */
export function detectCrossUserAccess(reqUserId, returnedItems) {
  if (!Array.isArray(returnedItems)) return null;
  const offending = new Set();
  let count = 0;
  for (const item of returnedItems) {
    if (!item || typeof item.user_id !== 'number') continue;
    if (item.user_id !== reqUserId) {
      offending.add(item.user_id);
      count++;
    }
  }
  if (offending.size === 0) return null;
  return {
    offending_user_ids: [...offending].sort((a, b) => a - b),
    count,
  };
}

/**
 * 偵測「日誌訊息含機密金鑰原文」
 *
 * @param {string} logMessage
 * @param {string[]} secretValues - 機密金鑰值清單（caller 從 cache 拿）
 * @returns {null | {matched_count: number}}
 *   為防止「告警細節本身洩漏機密」，回傳只有計數、不含哪個 secret 中招
 */
export function detectSecretInLogs(logMessage, secretValues) {
  if (typeof logMessage !== 'string') return null;
  if (!Array.isArray(secretValues)) return null;
  let matched = 0;
  for (const value of secretValues) {
    if (typeof value !== 'string') continue;
    if (value.length < SECRET_MIN_LENGTH) continue;
    if (logMessage.includes(value)) matched++;
  }
  if (matched === 0) return null;
  return { matched_count: matched };
}

/**
 * 偵測「1h 內讀取超過閾值」
 *
 * @param {number} recentReadCount - 過去 windowHours 內讀取筆數（caller SQL 算好傳進）
 * @param {number} [threshold=BULK_READ_THRESHOLD]
 * @param {number} [windowHours=BULK_READ_WINDOW_HOURS]
 * @returns {null | {count: number, threshold: number, window_hours: number}}
 */
export function detectBulkRead(
  recentReadCount,
  threshold = BULK_READ_THRESHOLD,
  windowHours = BULK_READ_WINDOW_HOURS,
) {
  if (typeof recentReadCount !== 'number') return null;
  if (recentReadCount < 0) return null;
  if (recentReadCount <= threshold) return null;
  return {
    count: recentReadCount,
    threshold,
    window_hours: windowHours,
  };
}
