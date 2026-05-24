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
 * v1.19.13 變更：
 *   value-side keyword 從「含 password 字樣就擋」改成「賦值樣式（KEY: VALUE
 *   或 KEY=VALUE）且 VALUE ≥ 8 字才擋」。理由：reference 文件大量提到密鑰名稱
 *   （例 anydesk.bot_kkvin.unattended_password）會被舊邏輯誤判、實際上那只是
 *   「鑰匙的名字」、不是「鑰匙本身」。對應 openspec/changes/
 *   v1.19.13-secret-detect-keyword-tighten/proposal.md
 *
 *   同時、detected=true 時回傳體新增 matched_text 欄位（截 80 字）、讓 caller
 *   能在 400 回應裡告訴 AI 哪段觸發、第一次就能改對、不用試 3 次。
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
 * @returns {{ detected: boolean, rule?: string, reason?: string, matched_text?: string }}
 *   - detected: 是否命中
 *   - rule: detected_by 標籤（regex:xxx / keyword:xxx / heuristic:xxx）
 *   - reason: 給 caller 看的白話原因
 *   - matched_text: 觸發片段（≤ 80 字、v1.19.13 起）
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
    const m = value.match(pattern);
    if (m) {
      return {
        detected: true,
        rule: `regex:${name}`,
        reason: `value 符合 ${name} 格式`,
        matched_text: truncateMatch(m[0]),
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
          // v1.19.13 review I-1：不 echo 周圍上下文、避免把 title 中相鄰的個資
          //（手機／信箱）一併 echo 進 400 body／log。只回 keyword 字面。
          matched_text: keyword,
        };
      }
    }
    for (const keyword of SECRET_KEYWORDS_CJK) {
      if (haystackOriginal.includes(keyword)) {
        return {
          detected: true,
          rule: `keyword:${keyword}`,
          reason: `title／description 含關鍵字「${keyword}」`,
          matched_text: keyword,
        };
      }
    }

    // v1.19.13：value-side keyword 只認賦值樣式（KEY: VALUE 或 KEY=VALUE）
    //   原本「value.includes(keyword) 就擋」會誤判：
    //     - 「anydesk.bot_kkvin.unattended_password」這種密鑰「名稱」reference
    //     - 「the password is in the vault」這種一般描述句
    //   新邏輯要求 keyword 後接 :／= 分隔符 + ≥ 8 字的「像值」字串才視為敏感、
    //   把「在講密碼這件事」跟「在貼真實密碼」分開。
    //   對應 openspec/changes/v1.19.13-secret-detect-keyword-tighten/spec.md S1
    const am = value.match(KEYWORD_ASSIGNMENT_REGEX);
    if (am) {
      const keyword = normalizeKeywordRuleName(am[1]);
      return {
        detected: true,
        rule: `keyword:${keyword}`,
        reason: `value 含 ${am[1]} 賦值樣式（值長度 ${am[2].length}）`,
        matched_text: truncateMatch(am[0]),
      };
    }
  }

  // 5. Length heuristic（最後保底）
  //    純英數字（含 -, _, +, /, =）≥ 20 字 且不含 CJK 字元 → 命中
  //    v1.19.13：點分隔識別字路徑（例 anydesk.bot_kkvin.unattended_password、
  //    process.env.MY_PASSWORD）不算「像 key／token」、跳過此啟發式。
  //    真實密鑰（JWT、AWS、GitHub PAT、OpenAI）都有專屬 regex 抓、不依賴啟發式。
  if (
    value.length >= 20 &&
    !CJK_REGEX.test(value) &&
    LONG_ALNUM_REGEX.test(value) &&
    !DOT_SEPARATED_IDENTIFIER_REGEX.test(value)
  ) {
    return {
      detected: true,
      rule: 'heuristic:long_alnum',
      reason: 'value 為 ≥20 字純英數字、看起來像 key / token',
      matched_text: truncateMatch(value),
    };
  }

  return { detected: false };
}

/**
 * v1.19.13：把命中片段截到 80 字以內、避免把真實密鑰整段 echo 回 console / log
 */
function truncateMatch(text) {
  if (typeof text !== 'string') return '';
  return text.length > 80 ? text.slice(0, 80) : text;
}

/**
 * v1.19.13：把抓到的關鍵字字面（可能含 -／_／空白）轉成 rule 名
 * 例：「API_KEY」→「api_key」、「API KEY」→「api_key」、「Api-Key」→「api_key」
 */
function normalizeKeywordRuleName(raw) {
  return raw.toLowerCase().replace(/[-\s]/g, '_');
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
  // v1.19.10：OwnMind 預定金鑰前綴
  // 對應 2026-05-22 incident：'vin-ownmind-admin-2026' 等字面金鑰被 commit 進公開 repo
  {
    name: 'ownmind_predefined_key',
    pattern: /\b(?:vin-)?ownmind-(?:admin|super|user|api)-[A-Za-z0-9-]{2,}\b/i,
  },
  // v1.19.10：預設密碼字面樣式（Password 開頭+8 位以上純數字）
  // 對應 2026-05-22 incident：'Password42760988' 這類常見「預設密碼模板」
  {
    name: 'default_password_literal',
    pattern: /\bPassword\d{8,}\b/,
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
 * v1.19.13：value-side keyword 賦值樣式偵測
 *
 * 命中條件（同時滿足）：
 *   1. 詞邊界開頭的 keyword（password / passwd / token / api_key / apikey
 *      / secret / credential / bearer）
 *   2. 後接 :／=／=> 任一分隔符（前後可有空白）
 *   3. 後接「像值」字串：可被引號包圍、≥ 8 個非空白非引號字元
 *
 * 不命中（過濾掉的誤判型）：
 *   - 「anydesk.bot_kkvin.unattended_password」沒 :／= 後綴、不命中
 *   - 「the password is in the vault」沒 :／=、不命中
 *   - 「password: hi」值長度 < 8、不命中（避免 form label 誤判）
 *   - 「mypassword=xxx」前面 m 不是詞邊界、不命中（複合詞）
 *
 * 注意：unicode flag 'u' 讓 \b 跟 CJK 字元邊界正確處理
 */
const KEYWORD_ASSIGNMENT_REGEX =
  /(?<![A-Za-z])(password|passwd|token|api[_\- ]?key|apikey|secret|credential|bearer)\s*(?:=>|[:=])\s*["']?([^\s"'`,;]{8,200})["']?/i;
// 用 (?<![A-Za-z]) 而非 \b：避免「mypassword=」的 password 被當成獨立 keyword、
// 但允許「API_TOKEN=」這種 _ 分隔的常見 env var 名稱（_ 不是 letter、不擋）。
//
// review I-3 明示：此 lookbehind 刻意不對稱、容許「_password=」「foo_password=」
//   「-token=」「123token=」等非字母前綴的賦值繼續命中。這些通常是 snake_case
//   / kebab-case env var 名稱（例：reset_password_token=abc12345）、被擋是正確的；
//   只有字母前綴的「mypassword=」「mytoken=」這類複合詞才被視為非密鑰、放行。
//
// review I-5 上界：值長度上限 200、避免 pathological 1MB 輸入讓 regex 引擎拖累。

/**
 * v1.19.13：點分隔識別字路徑（dot-separated identifier path）
 *
 * 形如「foo.bar.baz_qux」「process.env.MY_KEY」的字串、
 * 視為「對某個資源／鑰匙的命名 reference」、不是鑰匙本身。
 *
 * 規則：
 *   - 每段是合法的識別字（字母／底線開頭 + 字母／數字／底線）
 *   - 至少含**兩**個 `.` 分隔（即至少 3 段）
 *
 * review I-2：要求 ≥ 3 段、不收兩段樣式。理由：被砍掉 signature 的 JWT
 * （`eyJhbGc...eyJzdW...`）剛好是兩段樣式、字母／數字組成、會被當成識別字路徑放掉。
 * 真實密鑰名稱 reference（`anydesk.bot_kkvin.unattended_password`、
 * `process.env.MY_PASSWORD`）都是 3+ 段、不受影響。
 * 2 段的 `lodash.merge`、`package.json` 通常 < 20 字、走不到長度啟發式。
 *
 * 用於：length heuristic 的負向條件（看到這種樣式就放行、不視為密鑰）
 */
const DOT_SEPARATED_IDENTIFIER_REGEX =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){2,}$/;

/**
 * 純英數字＋少數符號（給長度啟發式用）
 * 包含：A-Z a-z 0-9 - _ + / = .
 *
 * 不含空白——code review I-1 修：原本含 \s 導致純英文筆記
 * （例：「Working on JWT integration today」）被誤判為密鑰、
 * 因為含空白＋字母長度 ≥ 20 就命中。實際密鑰格式都是單一 token
 * 沒空白（JWT / GitHub PAT / AWS / OpenAI）、WP password 走自己的
 * 專用 regex、heuristic 不需要支援空白。
 */
const LONG_ALNUM_REGEX = /^[A-Za-z0-9\-_+/=.]+$/;

/**
 * CJK Unicode ranges（中日韓統一表意文字）
 * 含中文／日文／韓文 → 通常是人話、不是 key
 */
const CJK_REGEX = /[　-〿぀-ゟ゠-ヿ一-鿿＀-ﾟ]/;
