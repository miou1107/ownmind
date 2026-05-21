/**
 * secret-detect — 偵測「看起來像敏感資料」的 value
 *
 * v1.19.1 引入。對應 openspec/changes/v1.19.1-secret-tool-routing/proposal.md §2.1
 *
 * 用於 memory API（POST/PUT /api/memory）寫入前的卡控：
 * 偵測到密碼／token／API key 命中 → 回傳 detected=true、route 把記憶寫入擋下、
 * 提示 caller 改用 /api/secret 路由。
 *
 * 設計原則：
 * - 保守偵測：寧可漏掉（false negative）也不要誤擋（false positive）
 *   理由：記憶 API 是高頻通道、誤擋一條正常記憶會卡死流程
 * - 偵測順序：bypass → regex → keyword → length heuristic
 *   regex 最精確、最先跑；heuristic 最寬鬆、最後當保底
 * - Pure function：不碰 DB / 不碰 fs / 不丟 exception、好測試
 *
 * @param {string|*} value - 要偵測的內容（通常是 memory.content）
 * @param {Object} [options]
 * @param {string} [options.title] - 對應記憶的 title（用於 keyword 偵測）
 * @param {string} [options.description] - 對應記憶的 description / metadata 註解
 * @param {boolean} [options.allow_bypass] - 明確 opt-in 跳過偵測（已寫 audit）
 * @param {boolean} [options.skip_keyword] - 跳過 keyword 偵測（narrative 類型專用）
 *   regex 跟 length heuristic 仍會跑、避免漏掉真貼進去的密鑰；
 *   只有 keyword（title/description/content 含 password/token/密碼...）不跑、
 *   避免討論密碼主題的 narrative 記憶（iron_rule、principle）被誤擋。
 * @returns {{ detected: boolean, rule?: string, reason?: string }}
 *   - detected: 是否命中
 *   - rule: detected_by 標籤（regex:xxx / keyword:xxx / heuristic:xxx）
 *   - reason: 給 caller 看的白話原因
 */
export function detectSecretLike(value, options = {}) {
  // 1. Bypass：明確 opt-in 跳過、其他檢查全部不跑
  if (options && options.allow_bypass === true) {
    return { detected: false };
  }

  // 2. 邊界輸入：null / undefined / 非字串 → 不丟、回 false
  if (typeof value !== 'string' || value.length === 0) {
    return { detected: false };
  }

  const title = (options && typeof options.title === 'string') ? options.title : '';
  const description =
    options && typeof options.description === 'string' ? options.description : '';

  // 3. Regex 偵測（最精確、優先）
  for (const { name, pattern } of SECRET_REGEXES) {
    if (pattern.test(value)) {
      return {
        detected: true,
        rule: `regex:${name}`,
        reason: `value 符合 ${name} 格式`,
      };
    }
  }

  // 4. Keyword 偵測（title + description 含敏感關鍵字）
  //    skip_keyword=true 時跳過、給 narrative 類型用（iron_rule / principle 等
  //    經常討論密碼主題、不應該被 keyword 誤擋；regex 跟 length heuristic 仍跑）
  if (!options.skip_keyword) {
    const haystack = `${title} ${description}`.toLowerCase();
    const haystackOriginal = `${title} ${description}`; // CJK 不轉小寫
    for (const keyword of SECRET_KEYWORDS_EN) {
      if (haystack.includes(keyword)) {
        return {
          detected: true,
          rule: `keyword:${keyword}`,
          reason: `title／description 含關鍵字「${keyword}」`,
        };
      }
    }
    for (const keyword of SECRET_KEYWORDS_CJK) {
      if (haystackOriginal.includes(keyword)) {
        return {
          detected: true,
          rule: `keyword:${keyword}`,
          reason: `title／description 含關鍵字「${keyword}」`,
        };
      }
    }
    // value 本身也掃英文 keyword（例如 content 出現 "api_key:" 模式）
    const valueLower = value.toLowerCase();
    for (const keyword of SECRET_KEYWORDS_EN) {
      if (valueLower.includes(keyword)) {
        return {
          detected: true,
          rule: `keyword:${keyword}`,
          reason: `value 含關鍵字「${keyword}」`,
        };
      }
    }
  }

  // 5. Length heuristic（最後保底）
  //    純英數字（含 -, _, +, /, =）≥ 20 字 且不含 CJK 字元 → 命中
  if (
    value.length >= 20 &&
    !CJK_REGEX.test(value) &&
    LONG_ALNUM_REGEX.test(value)
  ) {
    return {
      detected: true,
      rule: 'heuristic:long_alnum',
      reason: 'value 為 ≥20 字純英數字、看起來像 key / token',
    };
  }

  return { detected: false };
}

/**
 * 已知的密鑰格式 regex。命中即視為敏感。
 *
 * 設計：不用 ^/$ 錨定整字串、要能抓「embedded 在 narrative 文字中的密鑰」
 * （例如 iron_rule 內貼了真 token 想當例子）。
 * 為了降低 false positive，每條 regex 都設緊長度／字元 class 限制。
 */
const SECRET_REGEXES = [
  // WordPress Application Password: 4 字一組、恰好 6 組、空白分隔
  // 例：iXEN ops5 pJcy 8PJI lVFM heaH
  // 用 {5}（恰好 5 個分隔 = 6 組）而非 {5,}、避免普通英文文字偶然命中
  {
    name: 'wp_application_password',
    pattern: /\b[A-Za-z0-9]{4}(?:\s[A-Za-z0-9]{4}){5}\b/,
  },
  // JWT: header.payload.signature，三段 base64url
  // 每段至少 10 字降低 false positive
  {
    name: 'jwt',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  // GitHub PAT: ghp_ / ghs_ / gho_ / ghu_ 開頭 + 36+ 字元
  {
    name: 'github_pat',
    pattern: /gh[opsu]_[A-Za-z0-9]{36,}/,
  },
  // AWS Access Key ID: AKIA + 16 大寫英數字
  // 用 (?![A-Z0-9]) 確保後面不是更多大寫英數字（避免抓到 AKIA + 17+ 字的偶然字串）
  {
    name: 'aws_access_key',
    pattern: /AKIA[A-Z0-9]{16}(?![A-Z0-9])/,
  },
  // OpenAI API key: sk- 開頭、後接 20+ 字元（英數字／hyphen／_）
  {
    name: 'openai_api_key',
    pattern: /sk-[A-Za-z0-9_-]{20,}/,
  },
];

/**
 * 英文敏感關鍵字（不分大小寫比對）
 */
const SECRET_KEYWORDS_EN = [
  'password',
  'passwd',
  'token',
  'api_key',
  'api-key',
  'api key',
  'apikey',
  'secret',
  'credential',
  'bearer',
];

/**
 * 中文敏感關鍵字（原字元比對、不轉小寫）
 */
const SECRET_KEYWORDS_CJK = [
  '應用程式密碼',
  '存取金鑰',
  '客戶端密鑰',
  '密碼',
  '密鑰',
  '金鑰',
];

/**
 * 純英數字＋少數符號（給長度啟發式用）
 * 包含：A-Z a-z 0-9 - _ + / = . 空白
 */
const LONG_ALNUM_REGEX = /^[A-Za-z0-9\-_+/=.\s]+$/;

/**
 * CJK Unicode ranges（中日韓統一表意文字）
 * 含中文／日文／韓文 → 通常是人話、不是 key
 */
const CJK_REGEX = /[　-〿぀-ゟ゠-ヿ一-鿿＀-ﾟ]/;
