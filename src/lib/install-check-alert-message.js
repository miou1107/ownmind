/**
 * Render new install-check failures as a broadcast title and body.
 *
 * Pure. The reader-facing strings are Chinese on purpose: this text is shown to
 * the super admin by the session-start hook, and every other broadcast the
 * server writes (see src/jobs/nightly-upgrade-reminder.js) reads the same way.
 *
 * Three rules earn their code here:
 *   - identical failures across machines collapse into one entry, so "six
 *     machines, same WSL bash" reads as one row rather than six;
 *   - every entry is exactly one line, because the delivery path only ever
 *     shows the first few lines (see DELIVERY_MAX_LINES below);
 *   - a body that does not fit says how many entries were dropped, and the
 *     sentence that says so is the last line so it survives delivery. A silent
 *     cut reads as "that was everything", which is the defect this feature
 *     exists to remove.
 */

/** validateBroadcastPayload in src/routes/broadcast.js rejects anything longer. */
export const BROADCAST_BODY_LIMIT = 2000;

/**
 * The delivery envelope, not a style preference.
 *
 * Both clients that put a broadcast in front of the reader run the same
 * transform over the body:
 *
 *   String(bc.body || '').split('\n').slice(0, 5).join(' ').slice(0, 400)
 *
 * See hooks/lib/render-session-context.js and mcp/index.js. Whatever this
 * server writes, anything past the fifth line or the 400th character of the
 * joined result never reaches the reader — and clients already installed in the
 * field keep that transform regardless of what this server does next. So the
 * message is built to fit the envelope, not the 2000-character storage cap.
 *
 * These two constants are coupled to those two renderers. If you widen either
 * renderer, widen these with it; if you narrow one, narrow these first.
 */
export const DELIVERY_MAX_LINES = 5;
export const DELIVERY_MAX_CHARS = 400;

const LINE_SEPARATOR = '\n';
const FIELD_SEPARATOR = '｜';
const MACHINE_SEPARATOR = '、';

/** Visible proof that an entry was shortened. Never cut without leaving this. */
const CUT_MARKER = '…（截斷）';

function groupKey(failure) {
  return JSON.stringify([failure.check_name, failure.detail]);
}

/**
 * Collapse any run of whitespace, including newlines, into one space.
 * A detail string that carries its own newlines would otherwise spend other
 * entries' lines and push the footer out of the delivery window.
 */
function oneLine(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function footerFor(omitted, total) {
  return `（另有 ${omitted} 項未列出，總共 ${total} 項）`;
}

function buildEntries(newFailures) {
  const groups = new Map();

  for (const failure of newFailures) {
    const key = groupKey(failure);
    if (!groups.has(key)) {
      groups.set(key, {
        check_name: failure.check_name,
        detail: failure.detail,
        fix: failure.fix,
        machines: [],
        versions: new Set(),
      });
    }
    const group = groups.get(key);
    group.machines.push(`${failure.user_name}（${failure.machine}）`);
    if (failure.client_version) group.versions.add(failure.client_version);
    if (!group.fix && failure.fix) group.fix = failure.fix;
  }

  // Field order is survivability order. An entry may be shortened from the
  // right, so the fields that identify the problem (check, who, which machine,
  // which client version) come before the free prose that explains it.
  return [...groups.values()].map((group) => {
    const fields = [
      `${oneLine(group.check_name)} 失敗`,
      group.machines.map(oneLine).join(MACHINE_SEPARATOR),
    ];
    if (group.versions.size > 0) fields.push(`版本 ${[...group.versions].join(MACHINE_SEPARATOR)}`);
    const detail = oneLine(group.detail);
    if (detail) fields.push(detail);
    const fix = oneLine(group.fix);
    if (fix) fields.push(`修法：${fix}`);
    return fields.join(FIELD_SEPARATOR);
  });
}

/** Shorten to at most `allowance` characters, leaving the cut marker behind. */
function cut(text, allowance) {
  if (text.length <= allowance) return text;
  if (allowance <= CUT_MARKER.length) return text.slice(0, Math.max(0, allowance));
  return text.slice(0, allowance - CUT_MARKER.length) + CUT_MARKER;
}

/**
 * Share `budget` characters between lines of the given lengths.
 *
 * Water-filling: a line shorter than its equal share keeps its whole text and
 * hands the slack to the lines that are still over. One long entry therefore
 * cannot crowd out the short ones, and short entries do not waste the room a
 * long one needs.
 *
 * @param {number[]} lengths
 * @param {number} budget
 * @returns {number[]} allowance per line, summing to at most `budget`
 */
function allocate(lengths, budget) {
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
 * `maxLines` lines joined by one character each cost `maxLines - 1` characters
 * in the delivery transform, so that is taken off the budget up front.
 */
function fitToEnvelope(entries, limit, maxLines) {
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
 * @param {Array<Object>} newFailures
 * @param {{limit?: number, maxLines?: number}} [opts]
 * @returns {{title: string, body: string, omitted: number}}
 */
export function renderAlertMessage(newFailures = [], {
  limit = DELIVERY_MAX_CHARS,
  maxLines = DELIVERY_MAX_LINES,
} = {}) {
  const entries = buildEntries(newFailures);
  const total = entries.length;
  const title = `檢測出現 ${total} 個新問題`;

  if (total === 0) return { title, body: '', omitted: 0 };

  // The storage cap still applies; it is simply never the binding one.
  const effectiveLimit = Math.max(1, Math.min(limit, BROADCAST_BODY_LIMIT));
  const effectiveLines = Math.max(1, maxLines);

  const { lines, omitted } = fitToEnvelope(entries, effectiveLimit, effectiveLines);

  return { title, body: lines.join(LINE_SEPARATOR), omitted };
}

export default renderAlertMessage;
