/**
 * v1.20.2 follow-up #2：寫入操作收到 409 sync_token 過時 → 自動拿新 token 重試
 *
 * 背景（白話）：
 * sync_token（白話：每個 user 在伺服器端的「版本標記」、每次寫操作會被遞增）
 * 設計用意是防止「拿過時資料覆蓋伺服器」。但 user 同時開多個 AI session 寫入時、
 * A session 的 token 會被 B session 的寫入 bump、變成 A 再寫就 409、AI 必須手動跑
 * ownmind_init 重新拿 token。對使用者體驗很差、實務上每次寫入都會踩到。
 *
 * 解法：MCP 端攔 409 + 訊息含 sync_token 的錯誤 → 自動打 GET /api/memory/sync-token
 * 拿新 token、更新 body.sync_token、retry 1 次。對 AI 完全透明。
 *
 * 限制：
 *   - 只 retry 1 次、避免無限循環
 *   - 只對寫入操作（非 GET / HEAD）做
 *   - 必須真的是 sync_token 過時錯誤（訊息含 sync_token 字眼）、不是隨便 409 都 retry
 */

/**
 * 判斷錯誤是否該被自動重試
 * @param {object} param - { method, status, errorMessage }
 * @returns {boolean}
 */
export function shouldRetryForSyncToken({ method, status, errorMessage }) {
  // GET / HEAD 是讀取操作、不會碰到 sync_token 邏輯、不該 retry
  if (method === 'GET' || method === 'HEAD') return false;

  // 必須是 409 衝突狀態
  if (status !== 409) return false;

  // 必須是 sync_token 相關錯誤（避免其他 409 也被誤 retry）
  return /sync_token/i.test(errorMessage || '');
}

/**
 * 把 body 內的 sync_token 換成新值
 * @param {object} body - 請求 body
 * @param {string} newToken - 新 token 值
 * @returns {boolean} - 有沒有成功換（body 沒 sync_token 欄位就 false）
 */
export function applyNewToken(body, newToken) {
  if (!newToken) return false;
  if (!body || typeof body !== 'object') return false;
  if (!('sync_token' in body)) return false;
  body.sync_token = newToken;
  return true;
}
