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

  return parts.length > 0 ? parts.join('\n') : JSON.stringify(data);
}
