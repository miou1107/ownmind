/**
 * Build the request body for ownmind_log_session (v1.26.61).
 *
 * Why this is a module rather than four lines in the switch: it decides what a session
 * record is allowed to be missing, and that decision is the fix for a bug that has now
 * been filed three times (Eric's #9 for log_session, and two earlier ones — see the
 * header of required-args.js). A decision with that history should be executed by a test,
 * not read.
 *
 * The rule:
 *
 *   summary — required, and never defaulted. It is the only field with no source but the
 *             caller, and a session row that says nothing is worse than no row.
 *   tool    — defaulted from the client. The MCP process already holds this in
 *             CLIENT_TOOL and already sends it as the heartbeat tool, the
 *             `x-ownmind-tool` header and `client_tool` on bug reports. Requiring the
 *             caller to repeat it was asking to be told something we know.
 *   model   — optional, and never invented. Nothing in this process knows it, and
 *             writing "unknown" would put a fabricated value into the column that feeds
 *             the statistics dashboard's model distribution. Absent means absent.
 *
 * The trade this replaces: requiring `model` discarded the whole session record — the
 * summary, the project, the turn count, the friction points, the suggestions — to protect
 * one string that was missing anyway.
 */

/**
 * Absent for a field this module *defaults* — tool, model, machine.
 *
 * Whitespace counts, because storing "   " as a tool name helps nobody and the caller
 * clearly meant nothing by it.
 */
function blankOrSpaces(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  return false;
}

/**
 * Absent for `summary`, which is different and must stay different.
 *
 * `summary` is enforced by the client guard (required-args.js) and by the server's
 * requireFields, and both count only the empty string as missing — deliberately, with a
 * test pinning it. If this module were stricter, a summary of "   " would pass the guard,
 * be stripped here, and reach the server without it: a generic 400 in place of the clear
 * client-side error, which is exactly the failure loop this release exists to end.
 * Found in adversarial review.
 */
function absent(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string' && v === '') return true;
  return false;
}

/**
 * @param {object} args        The tool-call arguments, as delivered.
 * @param {object} opts
 * @param {string} opts.clientTool  CLIENT_TOOL from mcp/index.js.
 * @returns {object} The body to POST to /api/session. Keys that carry nothing are absent
 *   rather than present-and-empty, so the server stores NULL instead of ''.
 */
export function buildSessionLogBody(args, { clientTool }) {
  const a = (args && typeof args === 'object') ? args : {};
  const body = {};

  if (!absent(a.summary)) body.summary = a.summary;
  body.tool = blankOrSpaces(a.tool) ? clientTool : a.tool;
  if (!blankOrSpaces(a.model)) body.model = a.model;
  if (!blankOrSpaces(a.machine)) body.machine = a.machine;
  if (a.details !== undefined) body.details = a.details;

  return body;
}
