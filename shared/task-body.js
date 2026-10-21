/**
 * What a task card may contain, decided once for the MCP client and the server (v1.31.3).
 *
 * A card is a dispatch note for one AI session: a project, a title, a body short enough to
 * be done in one sitting, and a few links. The caps are the design, not a safety margin —
 * a queue of epics is a backlog, and a backlog is what nobody works.
 */

export const MAX_TITLE_LENGTH = 500;
export const MAX_BODY_LENGTH = 4000;
export const MAX_RESULT_LENGTH = 4000;
export const MAX_LINKS = 10;
export const MAX_LINK_LENGTH = 1000;

export const TASK_STATUSES = Object.freeze(['open', 'claimed', 'done', 'reviewed', 'dropped']);

/**
 * v1.33.0: a card is closed by `done` with evidence — the verification the AI actually ran
 * and what it printed. Fewer characters than this is a method without a result ("ran the
 * tests"), which is what the person used to have to check by hand.
 */
export const MIN_EVIDENCE_LENGTH = 20;
export const MAX_EVIDENCE_LENGTH = 4000;
export const EVIDENCE_REQUIRED_ERROR = 'evidence is required: the verification you ran and what it printed';

/** Hours a claim may sit without a `done` before the daily job hands the card back. */
export const CLAIM_TTL_HOURS = 24;

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Links are a small map of name → URL-ish string. Keys are trimmed and lowercased so
 * `Issue` and `issue` are one link, values are kept as given but capped.
 */
export function normalizeLinks(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const key = text(k).toLowerCase().slice(0, 64);
    const val = text(v).slice(0, MAX_LINK_LENGTH);
    if (!key || !val) continue;
    out[key] = val;
    if (Object.keys(out).length >= MAX_LINKS) break;
  }
  return out;
}

/**
 * @returns {{ ok: true, task: object } | { ok: false, error: string }}
 */
export function normalizeTaskCreate(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const project = text(a.project);
  const title = text(a.title);
  const body = text(a.body);
  if (!project || project.length > 255) return { ok: false, error: 'project is required (at most 255 characters)' };
  if (!title) return { ok: false, error: 'title is required' };
  if (title.length > MAX_TITLE_LENGTH) return { ok: false, error: `title is longer than ${MAX_TITLE_LENGTH} characters` };
  if (body.length > MAX_BODY_LENGTH) {
    return { ok: false, error: `body is longer than ${MAX_BODY_LENGTH} characters; a card that needs more is more than one session's work — split it` };
  }
  return {
    ok: true,
    task: {
      project,
      title,
      body,
      links: normalizeLinks(a.links),
      auto: a.auto === true,
      is_private: a.private === true || a.is_private === true,
    },
  };
}

/**
 * @returns {{ ok: true, result: string, evidence: string, links: object } | { ok: false, error: string }}
 */
export function normalizeTaskDone(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const result = text(a.result);
  if (!result) return { ok: false, error: 'result is required: say what was done and where to look' };
  if (result.length > MAX_RESULT_LENGTH) return { ok: false, error: `result is longer than ${MAX_RESULT_LENGTH} characters` };
  const evidence = text(a.evidence);
  if (evidence.length < MIN_EVIDENCE_LENGTH) return { ok: false, error: EVIDENCE_REQUIRED_ERROR };
  if (evidence.length > MAX_EVIDENCE_LENGTH) return { ok: false, error: `evidence is longer than ${MAX_EVIDENCE_LENGTH} characters` };
  return { ok: true, result, evidence, links: normalizeLinks(a.links) };
}

/** The note appended to a card's body when its owner or an admin sends it back to open. */
export function reopenNote({ name, note, at }) {
  const when = at instanceof Date ? at.toISOString() : String(at || '');
  const why = text(note);
  return `\n\n[reopened ${when} by ${name || 'the owner'}]${why ? ` ${why}` : ''}`;
}

/** The note appended to a card's body when a claim is dropped or expires. */
export function claimNote(kind, { name, reason, at }) {
  const when = at instanceof Date ? at.toISOString() : String(at || '');
  if (kind === 'expired') return `\n\n[claim expired ${when}] ${name || 'the holder'} did not finish within ${CLAIM_TTL_HOURS} hours; the card is open again.`;
  return `\n\n[dropped ${when} by ${name || 'the holder'}] ${text(reason) || 'no reason given'}`;
}
