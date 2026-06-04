/**
 * Client-side required-argument guard for ownmind_* MCP tools (v1.26.27).
 *
 * Mirrors the "missing" semantics of src/utils/require-fields.js so the MCP
 * client can reject an incomplete tool call BEFORE a network round-trip.
 *
 * Why this exists: two AIs filed near-identical "I sent the fields but the
 * server says they're missing" reports (ownmind_save, then ownmind_log_session).
 * In both, the arguments object delivered to the tool lacked the required keys,
 * so the client forwarded a partial body and the server answered with a generic
 * 400 "必填欄位缺少" — which looked like OwnMind ate the fields. Validating on the
 * client turns that into a fast, actionable, self-diagnosing error instead.
 *
 * Values are never included in the error message — only key names — so secrets
 * cannot leak through a validation failure.
 */

// Tools that accept an alternative key as a stand-in for a required field.
// The secret tools take `name` as an alias for `key` because AIs frequently
// confuse them with the memory tools (ownmind_get / ownmind_update), which key
// off `name`. Without this, an alias-only call would be wrongly rejected here.
const ARG_ALIASES = {
  ownmind_get_secret: { key: ['name'] },
  ownmind_set_secret: { key: ['name'] },
  ownmind_delete_secret: { key: ['name'] },
};

// Fields that are schema-`required` but must NOT be enforced by this client guard
// because they are deliberate human-in-the-loop gates, not data fields. Reporting
// such a field as a "just add it" missing argument would nudge a misbehaving AI to
// invent the value and defeat the safety design; the server still enforces them.
// ownmind_report_bug.confirm_string: the AI must never auto-fill it — the user
// types the exact submit phrase verbatim and the server verifies it.
const GUARD_EXEMPT_FIELDS = {
  ownmind_report_bug: ['confirm_string'],
};

// Same definition of "missing" as the server's requireFields(): undefined, null,
// empty string, and empty array all count as absent.
function isMissingValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string' && v === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

/**
 * Return the list of required fields that are absent from `args`, honoring any
 * per-tool aliases.
 *
 * @param {string} toolName
 * @param {*} args - the tool-call arguments object (any type tolerated)
 * @param {string[]} required - required field names (from the tool's inputSchema)
 * @param {Record<string, Record<string, string[]>>} aliases
 * @returns {string[]}
 */
function findMissingArgs(toolName, args, required, aliases = ARG_ALIASES) {
  if (!Array.isArray(required) || required.length === 0) return [];
  const safeArgs = (args && typeof args === 'object') ? args : {};
  const aliasMap = (aliases && aliases[toolName]) || {};
  const exempt = GUARD_EXEMPT_FIELDS[toolName] || [];

  return required.filter((field) => {
    if (exempt.includes(field)) return false;
    if (!isMissingValue(safeArgs[field])) return false;
    const alts = aliasMap[field] || [];
    // Satisfied if any alias key carries a present value.
    return !alts.some((alt) => !isMissingValue(safeArgs[alt]));
  });
}

/**
 * Build an actionable error message for a tool call missing required arguments.
 * Lists only key names (never values) so secrets can't leak.
 *
 * @param {string} toolName
 * @param {string[]} missing
 * @param {*} args
 * @returns {string}
 */
function buildMissingArgsError(toolName, missing, args) {
  const safeArgs = (args && typeof args === 'object') ? args : {};
  const receivedKeys = Object.keys(safeArgs);
  const receivedPart = receivedKeys.length > 0
    ? `received arguments: ${receivedKeys.join(', ')}`
    : 'received no arguments (the call delivered an empty arguments object — usually a caller/transport issue, not a server problem)';

  return (
    `${toolName}: missing required argument(s): ${missing.join(', ')}. `
    + `These fields are required but were not present in the tool call — ${receivedPart}. `
    + 'Re-send the call with the missing field(s) included at the top level.'
  );
}

export { ARG_ALIASES, GUARD_EXEMPT_FIELDS, findMissingArgs, buildMissingArgsError };
