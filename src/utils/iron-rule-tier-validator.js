/**
 * Iron Rule Tier — server route validator
 *
 * 把 v1.19 鐵律分級的 server-side 驗證邏輯抽出來、純函式、好測試。
 * 對應規格：openspec/changes/v1.19-iron-rule-tier/spec.md 場景 3、場景 4
 *
 * 設計重點：
 *   - tier 是 optional 欄位、舊客戶端沒帶 tier 仍然能正常寫入
 *   - tier 只允許出現在 type='iron_rule' 的記憶
 *   - 任何非法 tier 值都用明確訊息擋下、不靜默 fallback
 *     （fallback 是 client 端 / hook 端的責任、server 應該嚴格）
 */

import { isValidTier, VALID_TIERS, normalizeTier } from '../../shared/iron-rule-tier.js';

/**
 * 驗證一個寫入請求的 tier 欄位
 *
 * @param {object} params
 * @param {string} params.memoryType — 記憶的 type 欄位（iron_rule / project / ...）
 * @param {string} [params.tier] — 請求帶的 tier 值
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function validateTierRequest({ memoryType, tier }) {
  // 1. 沒帶 tier → 一律 ok（向後相容、舊客戶端不會壞）
  if (tier === undefined || tier === null) {
    return { ok: true };
  }

  // 2. 有帶 tier 但 type 缺失 → 拒絕（防呆）
  if (!memoryType) {
    return {
      ok: false,
      status: 400,
      error: 'tier 欄位需搭配明確的 type 一起寫入',
    };
  }

  // 3. tier 只能用在鐵律
  if (memoryType !== 'iron_rule') {
    return {
      ok: false,
      status: 400,
      error: `tier can only be set on type='iron_rule' memories（收到 type='${memoryType}'）`,
    };
  }

  // 4. tier 值必須合法
  if (!isValidTier(tier)) {
    return {
      ok: false,
      status: 400,
      error: `tier must be one of: ${VALID_TIERS.join(', ')}（收到: '${tier}'）`,
    };
  }

  return { ok: true };
}

/**
 * 決定寫入 DB 的 tier 值（兜底）
 *
 * 正常流程：caller 應該先呼叫 validateTierRequest、有錯就 return 400。
 * 這個函式只是兜底、保證寫進 DB 的 tier 一定合法。
 *
 * @param {object} params
 * @param {string} params.memoryType
 * @param {string} [params.tier]
 * @returns {string|null} — iron_rule 回傳合法 tier 字串、其他 type 回傳 null
 */
export function applyTierDefault({ memoryType, tier }) {
  if (memoryType !== 'iron_rule') {
    return null;
  }
  if (tier === undefined || tier === null) {
    return 'default';
  }
  return normalizeTier(tier);
}
