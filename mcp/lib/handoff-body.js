/**
 * Build the request body for ownmind_handoff_create (v1.30.4).
 *
 * The same defect as Eric's bug #9, one table over, and therefore the same decision — see
 * mcp/lib/session-log-body.js, which this file deliberately mirrors rather than paraphrases.
 *
 * What was wrong: the tool declared `project` and `content` required and the three `from_*`
 * fields optional, while POST /api/handoff required `project, from_tool, from_model, content`.
 * A caller that read the schema and sent the two required fields got a 400 and lost the
 * handoff, every time. The columns have been nullable since db/001_init.sql:76-87, so the
 * endpoint disagreed with its own storage as well as with its only client.
 *
 * The rule:
 *
 *   project, content — required, never defaulted. They are the two fields with no source but
 *                      the caller, and a handoff row that hands over nothing is worse than
 *                      no row.
 *   from_tool        — defaulted from the client. The MCP process already holds this in
 *                      CLIENT_TOOL and already sends it as the heartbeat tool and the
 *                      `x-ownmind-tool` header.
 *   from_model       — optional, and never invented. Nothing in this process knows it, and
 *                      writing "unknown" would put a fabricated value into a column the
 *                      console groups by.
 *   from_machine     — optional, same reasoning.
 */

/**
 * Absent for a field this module *defaults* or drops — the three `from_*` fields.
 *
 * Whitespace counts: storing "   " as a tool name helps nobody, and the caller clearly meant
 * nothing by it.
 */
function blankOrSpaces(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  return false;
}

/**
 * Absent for `project` and `content`, which are different and must stay different.
 *
 * Only the empty string counts, matching the client guard and the server's requireFields. A
 * stricter rule here would let `content: "   "` pass the guard, be stripped, and come back as
 * a generic 400 in place of the clear client-side error — the failure loop this change exists
 * to end, reintroduced by the fix. That is the trap adversarial review caught in the
 * session-log version.
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
 * @returns {object} The body to POST to /api/handoff. Keys that carry nothing are absent
 *   rather than present-and-empty, so the server stores NULL instead of ''.
 */
export function buildHandoffBody(args, { clientTool }) {
  const a = (args && typeof args === 'object') ? args : {};
  const body = {};

  if (!absent(a.project)) body.project = a.project;
  if (!absent(a.content)) body.content = a.content;
  body.from_tool = blankOrSpaces(a.from_tool) ? clientTool : a.from_tool;
  if (!blankOrSpaces(a.from_model)) body.from_model = a.from_model;
  if (!blankOrSpaces(a.from_machine)) body.from_machine = a.from_machine;

  return body;
}
