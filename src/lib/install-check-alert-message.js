/**
 * Render new install-check failures as a broadcast title and body.
 *
 * Pure. The reader-facing strings are Chinese on purpose: this text is shown to
 * the super admin by the session-start hook, and every other broadcast the
 * server writes (see src/jobs/nightly-upgrade-reminder.js) reads the same way.
 *
 * Two rules earn their code here:
 *   - identical failures across machines collapse into one entry, so "six
 *     machines, same WSL bash" reads as one row rather than six;
 *   - a body that does not fit says how many entries were dropped. A silent cut
 *     reads as "that was everything", which is the defect this feature exists
 *     to remove.
 */

/** validateBroadcastPayload in src/routes/broadcast.js rejects anything longer. */
export const BROADCAST_BODY_LIMIT = 2000;

const SEPARATOR = '\n\n';

function groupKey(failure) {
  return JSON.stringify([failure.check_name, failure.detail]);
}

function footerFor(omitted, total) {
  return `${SEPARATOR}（另有 ${omitted} 項未列出，總共 ${total} 項）`;
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

  return [...groups.values()].map((group) => {
    const lines = [`${group.check_name} 失敗 — ${group.machines.join('、')}`];
    if (group.detail) lines.push(`  ${group.detail}`);
    if (group.fix) lines.push(`  修法：${group.fix}`);
    if (group.versions.size > 0) lines.push(`  版本 ${[...group.versions].join('、')}`);
    return lines.join('\n');
  });
}

/**
 * @param {Array<Object>} newFailures
 * @param {{limit?: number}} [opts]
 * @returns {{title: string, body: string, omitted: number}}
 */
export function renderAlertMessage(newFailures = [], { limit = BROADCAST_BODY_LIMIT } = {}) {
  const entries = buildEntries(newFailures);
  const total = entries.length;
  const title = `檢測出現 ${total} 個新問題`;

  if (total === 0) return { title, body: '', omitted: 0 };

  // Step 1: Try to fit all entries. If they fit, return with no truncation.
  const fullBody = entries.join(SEPARATOR);
  if (fullBody.length <= limit) {
    return { title, body: fullBody, omitted: 0 };
  }

  // Step 2: Find the largest k in [1, total-1] such that entries[0..k-1]
  // joined with footer fits within the limit.
  for (let k = total - 1; k >= 1; k -= 1) {
    const kept = entries.slice(0, k);
    const omitted = total - k;
    const footer = footerFor(omitted, total);
    const candidate = kept.join(SEPARATOR) + footer;

    if (candidate.length <= limit) {
      return { title, body: candidate, omitted };
    }
  }

  // Step 3: Even one entry plus footer does not fit. Deliver a cut version
  // of entries[0] with a cut marker and omitted count.
  const CUT_MARKER = '\n…（内容已截斷）';
  const footer = footerFor(total - 1, total);
  const room = Math.max(1, limit - footer.length - CUT_MARKER.length);
  const cutBody = entries[0].slice(0, room) + CUT_MARKER + footer;

  return { title, body: cutBody, omitted: total - 1 };
}

export default renderAlertMessage;
