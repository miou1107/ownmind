/**
 * mcp/lib/enrich-error.js — v1.18.6
 *
 * 為什麼：
 *   過去 error event 只記 { tool_name, error }、缺結構化欄位（http_status / stack /
 *   payload type 等）→ 觀測缺口。改成豐富 details、保留 error 欄位向後相容。
 *
 * 設計：純 function、好測試、不依賴外部狀態。
 */

/**
 * v1.18.8：抽出共用 helper。
 *
 * 任何「err → 結構化欄位」邏輯都用這個、給多個 logEvent 寫入點共用（error event /
 * update_failed event / 未來其他）。回傳的物件不含 error / tool_name 等 caller-specific
 * 欄位、由 caller 自己組裝。
 *
 * @param {Error|string|null} error
 * @returns {object} - { error_message, error_name, error_code?, stack?, http_status? }
 */
export function errorAliasFields(error) {
  const msg = error?.message || String(error || '');
  const fields = {
    error_message: msg,
    error_name: error?.name || 'Error',
  };
  if (error?.code) fields.error_code = error.code;
  if (error?.stack) {
    fields.stack = String(error.stack).split('\n').slice(0, 5).join('\n');
  }
  const statusMatch = msg.match(/^API (\d{3}):/);
  if (statusMatch) fields.http_status = parseInt(statusMatch[1], 10);
  return fields;
}

/**
 * 把 Error 物件變成豐富的 details object 給 MCP tool error event 用。
 *
 * @param {Error|string|null} error - 原 error 物件（Error / string / null）
 * @param {string} toolName - MCP 工具名（ownmind_save / ownmind_update / ...）
 * @param {object|null} args - MCP tool 呼叫的 args（用來算 payload_summary）
 * @returns {object} - { error, error_message, error_name, tool_name, stack?, http_status?, payload_summary? }
 */
export function enrichErrorDetails(error, toolName, args) {
  const fields = errorAliasFields(error);
  const details = {
    error: fields.error_message,           // 向後相容（v1.17.x~v1.18.5 都用這欄）
    ...fields,
    tool_name: toolName,
  };
  // payload summary（不洩漏敏感資料、只記結構欄位）
  if (args && typeof args === 'object') {
    const summary = {};
    if (args.type) summary.type = args.type;
    if (args.code) summary.code = args.code;
    if (args.id !== undefined) summary.id = args.id;
    if (typeof args.title === 'string') summary.title_length = args.title.length;
    if (typeof args.content === 'string') summary.content_length = args.content.length;
    if (Array.isArray(args.tags)) summary.tags_count = args.tags.length;
    if (Object.keys(summary).length > 0) details.payload_summary = summary;
  }
  return details;
}
