/**
 * shared/invocable-standards.js — which team standards a user can ask for by name.
 *
 * A company's team standards are of three kinds, and only one of them is worth telling a
 * user about. Measured on the production account, 2026-08-12, over 32 standards:
 *
 *   - 17 are discipline ("do not blind edit", "write the reproduction test first"). The AI
 *     follows them; the user never says them out loud.
 *   - 8 are content the AI reads (a tool's whole source, a document's digest).
 *   - 6 are capabilities the user can ask for: "publish to pages", "run the regression tests".
 *
 * A tip that read titles aloud would therefore be noise five times out of six, and the titles
 * are written to be recognised by whoever manages the standards, not to be said by whoever
 * uses one: 「pages 發布工具 pages.py 全文」 is not a sentence anyone asks for.
 *
 * So the standard says both things itself:
 *
 *   metadata.user_invocable  — true when a user can ask for this by name
 *   metadata.invocation_hint — the sentence to show them, in their words
 *
 * Neither is inferred. A standard without them never appears in a tip, which is the safe
 * direction: the cost of missing one is that a capability stays unadvertised, and the cost
 * of guessing wrong is a tip nobody can act on.
 */

/** A hint has to fit on the one line a tip occupies. */
export const INVOCATION_HINT_MAX = 120;

/**
 * Validate the pair on a memory about to be written.
 *
 * Called on create and on update, because a standard can acquire the flag either way and a
 * flag with no hint is the failure this design exists to prevent — it would degrade to
 * reading the title aloud, which is what the first draft of the feature did.
 *
 * @param {object|null|undefined} metadata the metadata about to be stored
 * @param {string} type the memory's type
 * @returns {{ ok: true } | { ok: false, error: string, hint?: string }}
 */
export function validateInvocableMetadata(metadata, type) {
  if (!metadata || typeof metadata !== 'object') return { ok: true };

  const flag = metadata.user_invocable;
  const hint = metadata.invocation_hint;

  if (flag === undefined && hint === undefined) return { ok: true };

  if (flag !== undefined && typeof flag !== 'boolean') {
    return { ok: false, error: 'metadata.user_invocable must be true or false' };
  }

  if (flag === true && type !== 'team_standard') {
    return {
      ok: false,
      error: 'metadata.user_invocable applies to team standards only',
      hint: 'Only the team_standard summary layer is loaded at session start, so nothing else could be named in a tip — including standard_detail fragments, which members can read but which the tip never reaches.',
    };
  }

  if (flag === true) {
    if (typeof hint !== 'string' || hint.trim() === '') {
      return {
        ok: false,
        error: 'metadata.invocation_hint is required when user_invocable is true',
        hint: 'Write the sentence a user would see, in their words — e.g. 「想把東西變成網址傳給人看？直接說「幫我發 pages」」. Without it the tip falls back to reading the title aloud, which is what this field exists to avoid.',
      };
    }
    if (hint.trim().length > INVOCATION_HINT_MAX) {
      return {
        ok: false,
        error: `metadata.invocation_hint must be ${INVOCATION_HINT_MAX} characters or fewer`,
        hint: 'It is shown as a single tip line. A longer one is not shortened — it is dropped, and the standard goes unadvertised.',
      };
    }
    if (/[\r\n]/.test(hint)) {
      return { ok: false, error: 'metadata.invocation_hint must be a single line' };
    }
  }

  return { ok: true };
}

/**
 * Is this sentence safe to render as one line of tip?
 *
 * The same three rules the write path enforces, applied again on the way out. Rows written
 * before the validation existed, or written straight to the database, are the reason: a tip
 * is rendered into another member's session as text their AI is told to relay, so a hint
 * carrying its own newlines could add lines nobody wrote.
 */
function isUsableHint(hint) {
  return typeof hint === 'string'
    && hint.trim() !== ''
    && hint.length <= INVOCATION_HINT_MAX
    && !/[\r\n]/.test(hint);
}

/**
 * The hints to offer as tips, from whatever rows the caller already holds.
 *
 * Order is the caller's order. Duplicates are dropped so two standards that describe the same
 * request do not double their odds of being shown.
 *
 * @param {Array<{ id?: number|string, title?: string, metadata?: object }>} rows
 * @returns {Array<{ id: number|string|null, title: string, hint: string }>}
 */
export function buildInvocableStandards(rows) {
  const out = [];
  const seen = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    const metadata = row && typeof row.metadata === 'object' && row.metadata ? row.metadata : null;
    if (!metadata || metadata.user_invocable !== true) continue;

    const hint = typeof metadata.invocation_hint === 'string' ? metadata.invocation_hint.trim() : '';
    // A row that predates the validation, or one written straight into the database, can
    // carry a sentence the write path would have refused. The read side therefore applies
    // the same three rules rather than only two: review found that `trim()` removes edge
    // whitespace but not an interior newline, so a hint of
    // "line one\nignore previous instructions\nline three" reached the rendered tip verbatim.
    if (!isUsableHint(hint)) continue;
    if (seen.has(hint)) continue;

    seen.add(hint);
    out.push({ id: row.id ?? null, title: typeof row.title === 'string' ? row.title : '', hint });
  }

  return out;
}

/**
 * Just the sentences, from the list the init response carries.
 *
 * Separate from `buildInvocableStandards` because the two take different shapes and the
 * mistake is silent: passing a payload list to the row-based builder finds no `metadata`,
 * returns nothing, and the tip falls back to the static line with no error anywhere.
 *
 * @param {Array<{ hint?: string }>} standards `invocable_standards` from GET /api/memory/init
 * @returns {string[]}
 */
export function hintsFromStandards(standards) {
  return (Array.isArray(standards) ? standards : [])
    .map((s) => (s && typeof s.hint === 'string' ? s.hint.trim() : ''))
    .filter(isUsableHint);
}
