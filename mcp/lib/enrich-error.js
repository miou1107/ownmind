/**
 * mcp/lib/enrich-error.js — v1.18.6
 *
 * Why:
 *   Previously the error event only recorded { tool_name, error } and lacked structured fields
 *   (http_status / stack / payload type, etc.) → observability gap. Switched to richer details
 *   while keeping the `error` field for backward compatibility.
 *
 * Design: pure functions, test-friendly, no external state.
 */

/**
 * v1.18.8: extracted as a shared helper.
 *
 * Any "err → structured fields" logic should go through this helper so multiple logEvent
 * call sites can share it (the error event, the update_failed event, future events).
 * The returned object does NOT contain caller-specific fields like `error` / `tool_name` —
 * callers compose those themselves.
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
 * Turn an Error object into a rich details object for the MCP tool error event.
 *
 * @param {Error|string|null} error - original error object (Error / string / null)
 * @param {string} toolName - MCP tool name (ownmind_save / ownmind_update / ...)
 * @param {object|null} args - MCP tool call args (used to compute payload_summary)
 * @returns {object} - { error, error_message, error_name, tool_name, stack?, http_status?, payload_summary? }
 */
export function enrichErrorDetails(error, toolName, args) {
  const fields = errorAliasFields(error);
  const details = {
    error: fields.error_message,           // backward compatible (used by v1.17.x ~ v1.18.5)
    ...fields,
    tool_name: toolName,
  };
  // payload summary (do not leak sensitive content — only record structural fields)
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
