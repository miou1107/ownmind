/**
 * pricing-lookup.js — model_pricing effective_date 查找邏輯
 *
 * 規則（S3）：
 *   SELECT * FROM model_pricing
 *   WHERE tool = ? AND model = ? AND effective_date <= ?
 *   ORDER BY effective_date DESC, id DESC
 *   LIMIT 1
 *
 * 抽成純函式方便單元測試（不依賴 DB），
 * 同時提供 DB 版 lookupPricing() 供 route / aggregation job 使用。
 *
 * 日期比對一律正規化成 YYYY-MM-DD 字串做字典序比較，
 * 避免 pg DATE 欄位回傳 UTC 午夜 Date 物件在 UTC- 時區下被 getDate() 誤判到前一天。
 */

import { query } from './db.js';

/**
 * 從一組 pricing row 中挑出特定 date 的生效價格。純函式，可在無 DB 環境下測試。
 *
 * @param {Array<object>} rows - 任意組合的 pricing rows
 * @param {string} tool
 * @param {string} model
 * @param {string|Date} date - 要查詢的日期（event 發生日）
 * @returns {object|null} - 符合條件的最新一筆，找不到回傳 null
 */
export function pickPricing(rows, tool, model, date) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const target = toYmd(date);

  const matching = rows.filter((r) => {
    if (r.tool !== tool || r.model !== model) return false;
    return toYmd(r.effective_date) <= target;
  });

  if (matching.length === 0) return null;

  matching.sort((a, b) => {
    const ay = toYmd(a.effective_date);
    const by = toYmd(b.effective_date);
    if (ay !== by) return by < ay ? -1 : 1;       // effective_date DESC
    const aid = a.id ?? -Infinity;
    const bid = b.id ?? -Infinity;
    if (aid !== bid) return bid - aid;             // id DESC（UNIQUE 理論上擋同日；保險用）
    return 0;
  });

  return matching[0];
}

/**
 * 計算 event 成本（USD）— 使用已查到的 pricing row。
 * tokens 單位為實際 token 數，pricing 單位為 per 1M tokens。
 *
 * 計價規則：
 *   - input / output / cache_write / cache_read：各自 *_per_1m 直接對應
 *   - reasoning_tokens：按 output_per_1m 計（與 OpenAI GPT-5 billing 一致；
 *     Claude / OpenCode 本來就沒 reasoning_tokens 欄位，影響為 0）
 *
 * @param {object} pricing - pickPricing() 回傳結果
 * @param {object} tokens - input_tokens / output_tokens / cache_creation_tokens /
 *                          cache_read_tokens / reasoning_tokens，缺值視為 0
 * @returns {number|null} - 成本（USD），pricing 為 null 時回傳 null
 */
export function computeCost(pricing, tokens) {
  if (!pricing) return null;

  const n = (v) => Number(v ?? 0);
  const p = (v) => Number(v ?? 0);

  const input = n(tokens.input_tokens) * p(pricing.input_per_1m);
  const output = n(tokens.output_tokens) * p(pricing.output_per_1m);
  const cacheWrite = n(tokens.cache_creation_tokens) * p(pricing.cache_write_per_1m);
  const cacheRead = n(tokens.cache_read_tokens) * p(pricing.cache_read_per_1m);
  const reasoning = n(tokens.reasoning_tokens) * p(pricing.output_per_1m);

  return (input + output + cacheWrite + cacheRead + reasoning) / 1_000_000;
}

/**
 * DB 版：查單一 (tool, model, effective_date <= date) 的 pricing。
 * 給 aggregation job 使用，對每批重算的 (tool, model, date) 組合呼叫一次。
 */
export async function lookupPricing(tool, model, date) {
  const result = await query(
    `SELECT id, tool, model, input_per_1m, output_per_1m,
            cache_write_per_1m, cache_read_per_1m, effective_date, notes
       FROM model_pricing
      WHERE tool = $1
        AND model = $2
        AND effective_date <= $3
      ORDER BY effective_date DESC, id DESC
      LIMIT 1`,
    [tool, model, toYmd(date)]
  );
  return result.rows[0] || null;
}

/**
 * 將輸入正規化為 YYYY-MM-DD 字串。
 * - 字串：若已是 YYYY-MM-DD 開頭就直接取前 10 碼
 * - Date：用 UTC 欄位取，避免時區偏移造成日期漂移
 */
function toYmd(d) {
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const parsed = new Date(d);
    return isoDate(parsed);
  }
  if (d instanceof Date) return isoDate(d);
  return isoDate(new Date(d));
}

function isoDate(date) {
  const y = String(date.getUTCFullYear()).padStart(4, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
