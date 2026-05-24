/**
 * privacy-redact — 把文字中的個資樣式替換成代稱（白話：把信箱、身分證、
 * 手機號碼這些可以辨識特定人的字串、換成 `<信箱-001>` 這種匿名標籤）
 *
 * 對應 OpenSpec 提案 v1.19.14-bug-report-tool（規格 §2.10、§3、§4 場景 23、23b）。
 *
 * 設計重點：
 *   - 用既有 `shared/privacy-detect.js` 的偵測結果
 *   - 同一個值多次出現時、共用同一個編號（同值同代稱）
 *   - 不同類型獨立編號（信箱從 001、手機從 001、身分證從 001）
 *   - 純函式、不碰 IO
 *   - 不丟例外（崩潰由 caller 用 try/catch fail-closed）
 *
 * 為什麼放共用層：
 *   - 後端 `ownmind_report_bug` 寫入前要強制套用（v4 設計、不靠 AI 自律）
 *   - 客戶端預覽顯示也可以用、雙重保險
 *
 * 代稱格式：`<類型中文-NNN>` 三位數字、由 001 開始遞增。
 */

import { detectPrivacyLeak } from './privacy-detect.js';

// 偵測類型 → 顯示用代稱前綴的對照表
const TYPE_LABEL_ZH = {
  email: '信箱',
  phone_tw_mobile: '手機',
  tw_id: '身分證',
};

/**
 * 把文字中的個資樣式替換成代稱
 *
 * @param {string} text - 要處理的原始文字
 * @param {Object} [options]
 * @param {string[]} [options.userPrompts] - 使用者最近的提問字串（沿用 privacy-detect 例外）
 * @returns {{ text: string, replacements: Array<{ type: string, original: string, label: string }> }}
 */
export function redactPrivacyPatterns(text, options = {}) {
  // 非字串或空字串：原樣回傳、不處理
  if (typeof text !== 'string' || text.length === 0) {
    return { text, replacements: [] };
  }

  const detection = detectPrivacyLeak(text, options);
  if (!detection.detected || detection.matches.length === 0) {
    return { text, replacements: [] };
  }

  // 按類型分組 + 為「同值」配發同一個代稱編號
  const counters = {}; // type → 已配發過的最高編號
  const labelMap = new Map(); // `${type}:${value}` → label
  const replacements = [];

  for (const { type, value } of detection.matches) {
    const key = `${type}:${value}`;
    if (labelMap.has(key)) continue; // 同值已經配過代稱

    counters[type] = (counters[type] || 0) + 1;
    const prefix = TYPE_LABEL_ZH[type] || type;
    const label = `<${prefix}-${String(counters[type]).padStart(3, '0')}>`;
    labelMap.set(key, label);
    replacements.push({ type, original: value, label });
  }

  // 替換：依「原始字串長度」從長到短處理、避免短的先替換造成切碎長的
  // （例：若 'a@b.com' 跟 'b.com' 同時是命中值、要先換長的）
  const ordered = [...labelMap.entries()].sort((a, b) => {
    const valA = a[0].split(':').slice(1).join(':');
    const valB = b[0].split(':').slice(1).join(':');
    return valB.length - valA.length;
  });

  let resultText = text;
  for (const [key, label] of ordered) {
    const value = key.split(':').slice(1).join(':');
    // 用 split-join 避免 regex 特殊字元（@ . 等不是 regex 元字元，但保守一點）
    resultText = resultText.split(value).join(label);
  }

  return { text: resultText, replacements };
}
