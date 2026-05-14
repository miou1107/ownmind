/**
 * log-mcp-call.js — v1.18.9 latency 埋點 helper
 *
 * 為什麼存在（解 v1.18.6 漏作項 + Gemini r3 C4 觀測缺口）：
 *   先前 mcp/index.js 主流程沒量「使用者看到 result 的真實感受時間」，
 *   admin dashboard 看不到 p95、無法判斷誰拖慢誰、調效。
 *
 * 為什麼抽 helper：
 *   邏輯雖簡單，但「不能因為 logEvent throw 就讓 tool call 失敗」這個不變式
 *   值得獨立 unit test、未來改動有保護網。
 *
 * 跟 enrich-error.js 同 pattern — pure module、好測。
 */

/**
 * 安全寫一筆 mcp_call event。任何 logEvent 失敗都被吞掉、不拋。
 *
 * @param {Object} args
 * @param {Function} args.logEvent - logEvent 函式 (event, details)
 * @param {string} args.tool - tool 名稱（不要傳 null/undefined、用 'unknown' 替）
 * @param {number} args.latencyMs - tool call 耗時 ms（已用 Date.now 算好）
 * @param {string} args.status - 'ok' | 'error'
 */
export function logMcpCallSafe({ logEvent, tool, latencyMs, status }) {
  try {
    logEvent('mcp_call', {
      tool: tool || 'unknown',
      latency_ms: latencyMs,
      status,
    });
  } catch (e) {
    // 不阻塞 response 主流程
    try {
      console.error('[log-mcp-call] logEvent failed:', e?.message || String(e));
    } catch { /* 連 console.error 都壞、放棄 */ }
  }
}
