/**
 * v1.21.0：Validator 註冊表
 *
 * 集中匯入所有內建 validator 模組、提供統一查找介面。
 * 規則驅動 lint 流程的核心：lint 鉤子讀 user 鐵律的 lint_validator.name、
 * 來這找對應 validator 跑 check。
 *
 * 未來新增 validator 流程：
 *   1. 在本目錄新 module、export { name, check }
 *   2. 加進下方 VALIDATOR_REGISTRY
 *   3. 文件補一筆
 */

import * as jargon from './jargon-explanation.js';
import * as mixed from './language-mixed-ratio.js';
import * as privacy from './privacy-detect.js';

/**
 * Validator 註冊表：name → module
 */
export const VALIDATOR_REGISTRY = {
  [jargon.name]: jargon,
  [mixed.name]: mixed,
  [privacy.name]: privacy,
};

/**
 * 找對應 name 的 validator module。找不到回 null。
 * @param {string} validatorName
 * @returns {{name: string, check: Function} | null}
 */
export function findValidator(validatorName) {
  if (!validatorName || typeof validatorName !== 'string') return null;
  return VALIDATOR_REGISTRY[validatorName] || null;
}

/**
 * 列出所有可用 validator name（給 user dashboard / 文件用）
 * @returns {string[]}
 */
export function listAvailableValidators() {
  return Object.keys(VALIDATOR_REGISTRY);
}

/**
 * 從 user 鐵律快取掃出所有啟用的 validator。
 *
 * 每條鐵律 metadata 可有 `lint_validator: { name, params }`：有設 → 啟用。
 * 同 validator name 被多條鐵律啟用 → 全部都回（一個 reply 可能因多條鐵律違反）。
 *
 * @param {Array<object>} rules - iron rules cache 內容
 * @returns {Array<{rule: string, validator: string, params: object}>}
 */
export function extractEnabledValidators(rules) {
  if (!Array.isArray(rules)) return [];
  const enabled = [];
  for (const rule of rules) {
    const lv = rule?.metadata?.lint_validator;
    if (!lv || typeof lv !== 'object') continue;
    if (typeof lv.name !== 'string' || !lv.name) continue;
    enabled.push({
      rule: rule.code || '',
      validator: lv.name,
      params: lv.params || {},
    });
  }
  return enabled;
}
