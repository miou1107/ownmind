/**
 * memory-error-classifier — split a catch-all error into a meaningful HTTP status
 *
 * Introduced in v1.19.1. See openspec/changes/v1.19.1-secret-tool-routing/proposal.md §2.3
 *
 * Design rationale:
 *   Previously the POST/PUT catch in src/routes/memory.js returned a 500 "create memory
 *   failed" / "update memory failed" directly, so neither the caller nor the AI knew why
 *   it failed. For example a PG check constraint violation, an invalid tier, or bad JSON
 *   all turned into a generic 500. This helper routes by error category:
 *
 *   - PG constraint violation (23xxx): 400 / 409 + a hint
 *   - PG connection exception (08xxx): 503 + a "please retry shortly" hint
 *   - JS SyntaxError: 400 "data format error"
 *   - otherwise unclassified: 500 + log stack (for debugging)
 *
 * Pure function — does not throw or log (logging is decided by the caller using the
 * returned logLevel/logStack).
 *
 * @param {*} err - any error (including null/undefined/non-Error)
 * @param {Object} [options]
 * @param {'create'|'update'|undefined} [options.context] - operation context, affects the default message
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

  // edge case: err is not an object (null / undefined / string / number) → 500 fallback
  if (!err || typeof err !== 'object') {
    return {
      status: 500,
      body: { error: baseErrorMessage },
      logLevel: 'error',
      logStack: true,
    };
  }

  // 1. caller explicitly carries .status → reuse it (for helpers that throw a custom status)
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

  // 2. PG SQLSTATE classification
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

  // check_violation → 400 (including the tier CHECK etc.)
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

  // other 23xxx integrity constraints → 400
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

  // 22xxx data exception → 400 (including string too long, parse failure, etc.)
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

  // 3. connection-type errors → 503
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

  // 4. JS built-in errors
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

  // 5. otherwise unclassified (including TypeError, ReferenceError, generic Error) → 500
  return {
    status: 500,
    body: { error: baseErrorMessage },
    logLevel: 'error',
    logStack: true,
  };
}
