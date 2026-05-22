/**
 * privacy-detect — 偵測「使用者隱私（個資）樣式」純函式
 *
 * v1.19.7 引入。v1.19.10 中性化、不綁特定使用者的鐵律編號。
 *
 * 適用 reply-lint hook：每輪 AI 回話結束時掃一次回應內容、
 * 命中即發出 'privacy_check' 事件。實際要不要擋下、由使用者自己的鐵律決定
 * （例如 Vin 設了 IR-041 對應此事件；其他使用者可選擇要不要寫類似鐵律）。
 *
 * 例外（白話：什麼情況不算命中）：
 *   當「使用者自己的提問」內容也含同樣字串時、表示是使用者主動分享、
 *   AI 回覆引用屬必要溝通、不算個資洩漏。
 *
 * 設計原則：
 * - 保守偵測（寧可漏掉也不誤擋）：reply-lint 是高頻通道、誤判等於強迫 AI 重寫無意義內容
 * - Pure function（純函式）：不碰 IO、不丟例外、好測試
 * - 偵測樣式：台灣身分證（含檢碼算式）、電子信箱、台灣手機（09 開頭）
 *
 * @param {string|*} text - 要掃的 AI 回應文字
 * @param {Object} [options]
 * @param {string[]} [options.userPrompts] - 使用者最近的提問字串陣列，用於例外比對
 * @returns {{ detected: boolean, matches: Array<{type, value}> }}
 *   - detected: 是否命中
 *   - matches: 命中的項目（去重後）；type 為 'tw_id' / 'email' / 'phone_tw_mobile'
 */
export function detectPrivacyLeak(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { detected: false, matches: [] };
  }

  const userPrompts = Array.isArray(options?.userPrompts)
    ? options.userPrompts.filter((s) => typeof s === 'string')
    : [];
  const userHaystack = userPrompts.join('\n');

  const seen = new Set();
  const matches = [];

  for (const { name, pattern, validate } of PRIVACY_PATTERNS) {
    // 每個 pattern 都是新的 RegExp（避免 lastIndex 共享）
    const re = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = m[0];
      if (validate && !validate(value)) continue;
      if (userHaystack && userHaystack.includes(value)) continue;
      // v1.19.7 code-review I-2：信箱類額外過 allowlist
      // （example.com / localhost / noreply 等開發/文件常見假信箱不算個資）
      if (name === 'email' && isAllowlistedEmail(value)) continue;
      const dedupKey = `${name}:${value}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      matches.push({ type: name, value });
    }
  }

  return { detected: matches.length > 0, matches };
}

/**
 * v1.19.7 code-review I-2：信箱白名單
 *
 * 排除以下情境（白話：這些不算「個人聯絡資料」）：
 *   - 假網域：example.com / example.org / example.net / .test / .invalid / .local / localhost
 *   - 系統發信前綴：noreply / no-reply / donotreply（這些不會回信、不是真人聯絡點）
 *
 * 目的：避免 AI 在解釋程式碼、Git 紀錄（如 Co-Authored-By 標籤）、文件範例時誤觸 privacy_check。
 * 留 v1.19.10 觀察期收集真實誤判紀錄、再決定要不要擴充清單。
 *
 * @param {string} email - 已通過 regex 命中的信箱字串
 * @returns {boolean} true = 在白名單、應視為非個資
 */
function isAllowlistedEmail(email) {
  const lower = email.toLowerCase();
  const atIdx = lower.indexOf('@');
  if (atIdx <= 0) return false;
  const local = lower.slice(0, atIdx);
  const domain = lower.slice(atIdx + 1);

  for (const prefix of EMAIL_ALLOWLIST_LOCAL) {
    if (local === prefix || local.startsWith(prefix + '.') || local.startsWith(prefix + '-') || local.startsWith(prefix + '_')) {
      return true;
    }
  }
  for (const d of EMAIL_ALLOWLIST_DOMAINS) {
    if (domain === d || domain.endsWith('.' + d)) return true;
  }
  return false;
}

const EMAIL_ALLOWLIST_DOMAINS = [
  'example.com',
  'example.org',
  'example.net',
  'localhost',
  'test',
  'invalid',
  'local',
];

const EMAIL_ALLOWLIST_LOCAL = [
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
];

/**
 * 隱私樣式表
 *
 * 設計：
 * - 身分證用台灣官方檢碼演算法二次驗證，幾乎沒誤判
 * - 電子信箱用標準格式（前綴 + @ + 網域 + 至少 2 字 TLD）
 * - 手機只抓台灣 09 開頭格式（國際碼版本 +886-9... 不在範圍內、避免誤判電話號碼類技術詞）
 */
/**
 * Privacy 類型顯示標籤（給 banner / reason 字串用）
 *
 * v1.19.12 把這份 export 出來、跟 PRIVACY_PATTERNS 並列。
 * 加新偵測類型時、必須同時更新此標籤對應、否則 banner 會顯示原始類型代號（如 'tw_id'）。
 */
export const PRIVACY_TYPE_LABELS = Object.freeze({
  tw_id: '身分證',
  email: '電子信箱',
  phone_tw_mobile: '手機',
});

const PRIVACY_PATTERNS = [
  {
    name: 'tw_id',
    // 開頭英文 1 碼 + 性別碼 1 或 2 + 數字 8 碼
    pattern: /\b[A-Z][12]\d{8}\b/g,
    validate: validateTwId,
  },
  {
    name: 'email',
    // 簡化版 RFC：[字／數／.+%-]+@[字／數／.-]+\.[字]{2,}
    // 用 \b 邊界 + TLD 至少 2 字、降低誤判
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    name: 'phone_tw_mobile',
    // 台灣手機：09 開頭 + 8 碼數字，中間可有 - 或空白分隔
    // 例：0912345678 / 0912-345-678 / 0912 345 678
    pattern: /\b09\d{2}[-\s]?\d{3}[-\s]?\d{3}\b/g,
    validate: validateTwMobile,
  },
];

/**
 * 台灣身分證檢碼算式（官方）：
 *   1. 第 1 字英文字母對應 2 位數（A=10、B=11、…）
 *   2. 取十位數 ×1、個位數 ×9，加總到 sum
 *   3. 第 2~9 碼依序乘 8、7、6、5、4、3、2、1，累加到 sum
 *   4. 第 10 碼為檢查碼，sum + 檢查碼 mod 10 == 0 即合法
 *
 * 這個算式精準到誤判機率約 1/10，配合格式比對後實務上幾乎不會誤命中。
 */
function validateTwId(id) {
  if (!/^[A-Z][12]\d{8}$/.test(id)) return false;
  const letterValues = {
    A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34,
    J: 18, K: 19, L: 20, M: 21, N: 22, O: 35, P: 23, Q: 24, R: 25,
    S: 26, T: 27, U: 28, V: 29, W: 32, X: 30, Y: 31, Z: 33,
  };
  const v = letterValues[id[0]];
  if (typeof v !== 'number') return false;
  let sum = Math.floor(v / 10) * 1 + (v % 10) * 9;
  const weights = [8, 7, 6, 5, 4, 3, 2, 1];
  for (let i = 0; i < 8; i++) {
    sum += parseInt(id[i + 1], 10) * weights[i];
  }
  sum += parseInt(id[9], 10);
  return sum % 10 === 0;
}

/**
 * 台灣手機額外檢查（避免「0911111111」這種全同數字測試碼）：
 *   - 全部同一個數字（0900000000 / 0911111111）視為假號碼，不算違反
 */
function validateTwMobile(raw) {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length !== 10) return false;
  if (!digits.startsWith('09')) return false;
  // 後 8 碼全相同（測試碼） → 不算個資
  const tail = digits.slice(2);
  if (/^(\d)\1{7}$/.test(tail)) return false;
  return true;
}
