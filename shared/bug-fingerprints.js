/**
 * OwnMind Bug Fingerprints — 錯誤指紋註冊表（程式碼層級的列舉）
 *
 * 對應 OpenSpec 提案 v1.19.14-bug-report-tool（規格 §2.9）。
 *
 * 用途：
 *   後端拋錯時、附 `suggest_report: true` + `bug_fingerprint: <某個註冊過的指紋>`、
 *   給客戶端跟使用者建議回報。指紋穩定（不含時間／使用者／請求 id），
 *   同一錯誤情境必生同一指紋、方便後端跨筆比對（spam 偵測、冷靜期）。
 *
 * 規則：
 *   1. 指紋名格式：<前綴>_<情境>，前綴需在 VALID_PREFIXES 內
 *   2. 只用小寫英文／數字／底線
 *   3. 不含時間戳／UUID／使用者 id
 *   4. 新指紋必須加進這份註冊表才能用（測試會擋未註冊的字串）
 *
 * 前綴分類：
 *   - mem      ：記憶寫入 / 更新相關（被擋下、欄位錯）
 *   - srv_err  ：後端內部錯誤（5xx 用、依錯誤類別細分）
 *   - clt      ：客戶端錯誤（請求格式錯、參數不齊）
 *   - lint     ：回話品質 lint hook 相關
 *   - sync     ：記憶同步相關
 *   - auth     ：認證 / 權限相關
 */

export const VALID_PREFIXES = ['mem', 'srv_err', 'clt', 'lint', 'sync', 'auth'];

export const BUG_FINGERPRINT_REGISTRY = {
  // ── 記憶寫入被擋（mem_blocked_*）─────────────────────────
  mem_blocked_secret_keyword: {
    category: 'mem',
    description: '記憶寫入因偵測到敏感關鍵字被擋（secret-detect keyword）',
  },
  mem_blocked_secret_regex: {
    category: 'mem',
    description: '記憶寫入因符合密鑰樣式 regex 被擋',
  },
  mem_blocked_privacy_pattern: {
    category: 'mem',
    description: '記憶寫入因偵測到個資（信箱／身分證／手機）被擋',
  },
  mem_blocked_iron_rule_quality: {
    category: 'mem',
    description: '鐵律寫入因品質檢查（缺白話／無背景）失敗被擋',
  },
  mem_blocked_invalid_type: {
    category: 'mem',
    description: '記憶寫入因 type 不在 allowed_types 被擋',
  },

  // ── 後端內部錯誤（srv_err_*、給 5xx handler 用）─────────
  srv_err_db_connection: {
    category: 'srv_err',
    description: '資料庫連線失敗（5xx）',
  },
  srv_err_db_query: {
    category: 'srv_err',
    description: '資料庫查詢例外（5xx）',
  },
  srv_err_migration_failure: {
    category: 'srv_err',
    description: 'migration 套用失敗、server 啟動阻斷',
  },
  srv_err_unhandled_exception: {
    category: 'srv_err',
    description: '其他未處理的後端例外（fallback 用）',
  },

  // ── 客戶端請求錯誤（clt_*）─────────────────────────────
  clt_invalid_payload: {
    category: 'clt',
    description: '請求 body 格式錯誤、無法解析',
  },
  clt_missing_required_field: {
    category: 'clt',
    description: '請求缺必填欄位',
  },
  clt_sync_token_stale: {
    category: 'clt',
    description: 'sync token 過期、需要重新 ownmind_init',
  },

  // ── 同步相關（sync_*）─────────────────────────────────
  sync_memory_file_corrupt: {
    category: 'sync',
    description: '本地記憶檔毀損、無法 parse',
  },

  // ── 認證相關（auth_*）─────────────────────────────────
  auth_key_invalid: {
    category: 'auth',
    description: 'api_key 無效或過期',
  },
  auth_permission_denied: {
    category: 'auth',
    description: '操作權限不足（例如非 admin 打 admin API）',
  },

  // ── 回話品質 lint（lint_*）────────────────────────────
  lint_hook_internal_error: {
    category: 'lint',
    description: 'reply-lint hook 內部錯誤、未能正常擋下違規',
  },
  lint_context_memory_missing: {
    category: 'lint',
    description: 'IR-036 jargon 判斷未實作跨 reply 詞彙記憶、已解釋過的詞被重複擋（v1.20.2 follow-up #3 修正）',
  },
  lint_hook_no_suggest_report_path: {
    category: 'lint',
    description: 'reply-lint hook 失敗時 stderr 沒帶 suggest_report 旗標跟 bug_fingerprint、AI 拿不到指紋無法送 bug report',
  },

  // ── 鐵律鉤子擋下相關（mem_*）───────────────────────
  mem_iron_rule_blocking_commit_no_fingerprint: {
    category: 'mem',
    description: 'pre-commit hook 因鐵律 verification 條件未滿足擋下 commit、但 stderr 沒帶 bug_fingerprint、AI 無法送 bug report',
  },
};

/**
 * 取得某個指紋的元資料；找不到回 null
 * @param {string|null|undefined} fingerprint
 * @returns {{category: string, description: string} | null}
 */
export function getFingerprintMetadata(fingerprint) {
  if (!fingerprint || typeof fingerprint !== 'string') return null;
  return BUG_FINGERPRINT_REGISTRY[fingerprint] || null;
}

/**
 * 檢查指紋是否已註冊
 * @param {string|null|undefined} fingerprint
 * @returns {boolean}
 */
export function isValidFingerprint(fingerprint) {
  return getFingerprintMetadata(fingerprint) !== null;
}

/**
 * 取得某個分類下所有指紋名
 * @param {string} prefix - 前綴名（例：'mem'、'srv_err'）
 * @returns {string[]}
 */
export function fingerprintsByPrefix(prefix) {
  if (!prefix || typeof prefix !== 'string') return [];
  return Object.keys(BUG_FINGERPRINT_REGISTRY).filter((key) => {
    const meta = BUG_FINGERPRINT_REGISTRY[key];
    return meta.category === prefix;
  });
}
