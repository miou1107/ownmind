/**
 * broadcast-envelope — fit a list of one-line entries into what delivery actually shows.
 *
 * Extracted from src/lib/install-check-alert-message.js in v1.26.99, when a second
 * server-written broadcast needed the same fitting. The alternative was a second
 * implementation of the same rule, and two answers to "what reaches the reader" is
 * exactly the defect this envelope exists to prevent.
 *
 * Pure: no clock, no database, no logging.
 */

/** validateBroadcastPayload in src/routes/broadcast.js rejects anything longer. */
export const BROADCAST_BODY_LIMIT = 2000;

/**
 * The delivery envelope, not a style preference.
 *
 * Both clients that put a broadcast in front of the reader run the same transform
 * over the body:
 *
 *   String(bc.body || '').split('\n').slice(0, 5).join(' ').slice(0, 400)
 *
 * See hooks/lib/render-session-context.js and mcp/index.js. Whatever this server
 * writes, anything past the fifth line or the 400th character of the joined result
 * never reaches the reader — and clients already installed in the field keep that
 * transform regardless of what this server does next. So messages are built to fit
 * the envelope, not the 2000-character storage cap.
 *
 * These two constants are coupled to those two renderers. If you widen either
 * renderer, widen these with it; if you narrow one, narrow these first.
 */
export const DELIVERY_MAX_LINES = 5;
export const DELIVERY_MAX_CHARS = 400;

export const LINE_SEPARATOR = '\n';
export const FIELD_SEPARATOR = '｜';

/** Visible proof that an entry was shortened. Never cut without leaving this. */
const CUT_MARKER = '…（截斷）';

/**
 * Collapse any run of whitespace, including newlines, into one space.
 * A detail string carrying its own newlines would otherwise spend other entries'
 * lines and push the footer out of the delivery window.
 */
export function oneLine(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function footerFor(omitted, total) {
  return `（另有 ${omitted} 項未列出，總共 ${total} 項）`;
}

/** Shorten to at most `allowance` characters, leaving the cut marker behind. */
export function cut(text, allowance) {
  if (text.length <= allowance) return text;
  if (allowance <= CUT_MARKER.length) return text.slice(0, Math.max(0, allowance));
  return text.slice(0, allowance - CUT_MARKER.length) + CUT_MARKER;
}

/**
 * Share `budget` characters between lines of the given lengths.
 *
 * Water-filling: a line shorter than its equal share keeps its whole text and hands
 * the slack to the lines that are still over. One long entry therefore cannot crowd
 * out the short ones, and short entries do not waste the room a long one needs.
 *
 * @param {number[]} lengths
 * @param {number} budget
 * @returns {number[]} allowance per line, summing to at most `budget`
 */
export function allocate(lengths, budget) {
  const allowances = new Array(lengths.length).fill(0);
  const pending = new Set(lengths.map((_, index) => index));
  let remaining = Math.max(0, budget);

  let settledOne = true;
  while (settledOne && pending.size > 0) {
    settledOne = false;
    const share = Math.floor(remaining / pending.size);
    for (const index of [...pending]) {
      if (lengths[index] <= share) {
        allowances[index] = lengths[index];
        remaining -= lengths[index];
        pending.delete(index);
        settledOne = true;
      }
    }
  }

  if (pending.size > 0) {
    const share = Math.floor(remaining / pending.size);
    let spare = remaining - share * pending.size;
    for (const index of pending) {
      allowances[index] = share + (spare > 0 ? 1 : 0);
      if (spare > 0) spare -= 1;
    }
  }

  return allowances;
}

/**
 * Choose how many entries to show and how much room each one gets.
 *
 * `maxLines` lines joined by one character each cost `maxLines - 1` characters in
 * the delivery transform, so that is taken off the budget up front. A body that does
 * not fit says how many entries were dropped, and the sentence that says so is the
 * last line so it survives delivery — a silent cut reads as "that was everything".
 *
 * @param {string[]} entries one-line entries, most important first
 * @param {number} limit character budget after the join
 * @param {number} maxLines lines the delivery transform keeps
 * @returns {{lines: string[], omitted: number}}
 */
export function fitToEnvelope(entries, limit, maxLines) {
  const total = entries.length;

  if (total <= maxLines) {
    const budget = limit - (total - 1);
    const allowances = allocate(entries.map((entry) => entry.length), budget);
    return { lines: entries.map((entry, i) => cut(entry, allowances[i])), omitted: 0 };
  }

  // The last line belongs to the footer, so at most maxLines - 1 entries show.
  const shown = Math.max(1, maxLines - 1);
  const omitted = total - shown;
  const footer = footerFor(omitted, total);
  const kept = entries.slice(0, shown);
  // shown + 1 lines cost `shown` join characters, plus the footer's own text.
  const budget = limit - shown - footer.length;
  const allowances = allocate(kept.map((entry) => entry.length), budget);

  return { lines: [...kept.map((entry, i) => cut(entry, allowances[i])), footer], omitted };
}

/**
 * Join fitted lines into a body, honouring the storage cap as well as the envelope.
 *
 * @param {string[]} entries
 * @param {{limit?: number, maxLines?: number}} [opts]
 * @returns {{body: string, omitted: number}}
 */
export function renderBody(entries, { limit = DELIVERY_MAX_CHARS, maxLines = DELIVERY_MAX_LINES } = {}) {
  if (entries.length === 0) return { body: '', omitted: 0 };
  // The storage cap still applies; it is simply never the binding one.
  const effectiveLimit = Math.max(1, Math.min(limit, BROADCAST_BODY_LIMIT));
  const effectiveLines = Math.max(1, maxLines);
  const { lines, omitted } = fitToEnvelope(entries, effectiveLimit, effectiveLines);
  return { body: lines.join(LINE_SEPARATOR), omitted };
}
