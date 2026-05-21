/**
 * memory-error-classifier — 把 catch-all error 拆成有意義的 HTTP 狀態
 *
 * v1.19.1 引入。對應 openspec/changes/v1.19.1-secret-tool-routing/proposal.md §2.3
 *
 * 設計緣由：
 *   之前 src/routes/memory.js POST/PUT 的 catch 直接回 500「建立記憶失敗」/「更新
 *   記憶失敗」，caller 跟 AI 都不知道為什麼錯。例如 PG check constraint 違反、tier
 *   不合法、JSON 格式錯，全部變成 generic 500。本 helper 依錯誤類別分流：
 *
 *   - PG constraint violation (23xxx)：400／409 + 帶 hint
 *   - PG connection exception (08xxx)：503 + hint「請稍候重試」
 *   - JS SyntaxError：400「資料格式錯誤」
 *   - 其他未分類：500 + log stack（給除錯）
 *
 * Pure function — 不丟、不 log（log 由 caller 用回傳的 logLevel/logStack 決定）。
 *
 * @param {*} err - 任何錯誤（含 null/undefined/非 Error）
 * @param {Object} [options]
 * @param {'create'|'update'|undefined} [options.context] - 操作情境、影響預設訊息
 * @returns {{
 *   status: number,
 *   body: { error: string, hint?: string, code?: string },
 *   logLevel: 'warn' | 'error',
 *   logStack: boolean
 * }}
 */
export function classifyMemoryError(err, options = {}) {
  const context = options && options.context;
  const baseErrorMessage =
    context === 'create' ? '建立記憶失敗'
    : context === 'update' ? '更新記憶失敗'
    : '處理記憶失敗';

  // 邊界：err 不是物件（null / undefined / 字串 / 數字）→ 500 fallback
  if (!err || typeof err !== 'object') {
    return {
      status: 500,
      body: { error: baseErrorMessage },
      logLevel: 'error',
      logStack: true,
    };
  }

  // 1. caller 明確帶 .status → 沿用（給 helper 拋自訂 status 用）
  if (typeof err.status === 'number' && err.status >= 400 && err.status < 600) {
    return {
      status: err.status,
      body: {
        error: err.message || baseErrorMessage,
      },
      logLevel: err.status >= 500 ? 'error' : 'warn',
      logStack: err.status >= 500,
    };
  }

  // 2. PG SQLSTATE 分類
  const code = typeof err.code === 'string' ? err.code : null;

  // unique_violation → 409 (Conflict)
  if (code === '23505') {
    return {
      status: 409,
      body: {
        error: baseErrorMessage,
        hint: '資料重複、已存在相同內容的記憶',
        code,
      },
      logLevel: 'warn',
      logStack: false,
    };
  }

  // not_null_violation → 400
  if (code === '23502') {
    const column = err.column ? `（欄位：${err.column}）` : '';
    return {
      status: 400,
      body: {
        error: baseErrorMessage,
        hint: `必填欄位不可為空${column}`,
        code,
      },
      logLevel: 'warn',
      logStack: false,
    };
  }

  // foreign_key_violation → 400
  if (code === '23503') {
    return {
      status: 400,
      body: {
        error: baseErrorMessage,
        hint: '參照資料不存在（foreign key 錯誤）',
        code,
      },
      logLevel: 'warn',
      logStack: false,
    };
  }

  // check_violation → 400（含 tier CHECK 等）
  if (code === '23514') {
    const constraint = err.constraint ? `（constraint：${err.constraint}）` : '';
    return {
      status: 400,
      body: {
        error: baseErrorMessage,
        hint: `欄位值違反 DB 限制${constraint}`,
        code,
      },
      logLevel: 'warn',
      logStack: false,
    };
  }

  // 其他 23xxx integrity constraint → 400
  if (code && code.startsWith('23')) {
    return {
      status: 400,
      body: {
        error: baseErrorMessage,
        hint: '資料完整性檢查失敗',
        code,
      },
      logLevel: 'warn',
      logStack: false,
    };
  }

  // 22xxx data exception → 400（含字串太長、parse 失敗等）
  if (code && code.startsWith('22')) {
    return {
      status: 400,
      body: {
        error: baseErrorMessage,
        hint: '資料格式不符',
        code,
      },
      logLevel: 'warn',
      logStack: false,
    };
  }

  // 3. Connection 類錯誤 → 503
  //    PG: 08xxx connection exception
  //    Node: ECONNREFUSED / ETIMEDOUT / EHOSTUNREACH / ENETUNREACH
  if (
    (code && code.startsWith('08')) ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH'
  ) {
    return {
      status: 503,
      body: {
        error: baseErrorMessage,
        hint: '服務暫時無法使用、請稍候重試',
        code,
      },
      logLevel: 'error',
      logStack: true,
    };
  }

  // 4. JS 內建錯誤
  if (err instanceof SyntaxError) {
    return {
      status: 400,
      body: {
        error: '資料格式錯誤（JSON / 文字解析失敗）',
        hint: err.message,
      },
      logLevel: 'warn',
      logStack: false,
    };
  }

  // 5. 其他未分類（含 TypeError、ReferenceError、generic Error）→ 500
  return {
    status: 500,
    body: { error: baseErrorMessage },
    logLevel: 'error',
    logStack: true,
  };
}
