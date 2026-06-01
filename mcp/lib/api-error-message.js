/**
 * Build a human/AI-readable error message from an API error response body.
 *
 * The server may return a structured error: { error, errors[], hint }. The
 * generic `error` alone is often not actionable — e.g. the iron-rule quality
 * check returns the specific failing items in `errors[]` and guidance in `hint`.
 * Surfacing only `error` (the previous behaviour) left the AI/user blind-retrying
 * without knowing what to fix. This composes all available parts.
 *
 * The top-level `error`/`message` stays first so callers that match on the
 * message (e.g. sync_token 409 retry detection) keep working.
 *
 * @param {*} data - parsed JSON body (object) or the raw value when not JSON
 * @param {string} text - raw response text, used as a fallback
 * @returns {string}
 */
export function buildApiErrorMessage(data, text) {
  if (typeof data !== 'object' || data === null) {
    return text;
  }

  const parts = [];
  const head = data.error || data.message;
  if (head) parts.push(head);

  if (Array.isArray(data.errors) && data.errors.length > 0) {
    for (const item of data.errors) parts.push(`- ${item}`);
  }

  if (data.hint) parts.push(`Hint: ${data.hint}`);

  // requireFields() (src/utils/require-fields.js) returns { error, missing, expected, received }.
  // Surfacing only `error` ("必填欄位缺少") hid the actionable detail and left the AI
  // blind-retrying. The missing list plus which keys actually arrived distinguishes the two
  // root causes: an empty `received` means the body never arrived (stale MCP process /
  // transport issue), whereas partial keys mean a genuine argument-mapping problem.
  if (Array.isArray(data.missing) && data.missing.length > 0) {
    parts.push(`Missing required fields: ${data.missing.join(', ')}`);
    if (data.received && typeof data.received === 'object' && !Array.isArray(data.received)) {
      const receivedKeys = Object.keys(data.received);
      parts.push(
        receivedKeys.length > 0
          ? `Received fields: ${receivedKeys.join(', ')}`
          : 'Received fields: (none — the request body was empty; this usually means a stale MCP process or a transport issue, not a missing argument)'
      );
    }
  }

  return parts.length > 0 ? parts.join('\n') : JSON.stringify(data);
}
