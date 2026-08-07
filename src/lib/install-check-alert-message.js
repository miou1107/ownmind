/**
 * Render new install-check failures as a broadcast title and body.
 *
 * Pure. The reader-facing strings are Chinese on purpose: this text is shown to
 * the super admin by the session-start hook, and every other broadcast the
 * server writes (see src/jobs/nightly-upgrade-reminder.js) reads the same way.
 *
 * Two rules earn their code here; the third now lives in broadcast-envelope.js
 * because a second server-written broadcast needs it too:
 *   - identical failures across machines collapse into one entry, so "six
 *     machines, same WSL bash" reads as one row rather than six;
 *   - every entry is exactly one line, because the delivery path only ever
 *     shows the first few lines (see DELIVERY_MAX_LINES).
 */

import {
  BROADCAST_BODY_LIMIT,
  DELIVERY_MAX_CHARS,
  DELIVERY_MAX_LINES,
  FIELD_SEPARATOR,
  oneLine,
  renderBody,
} from './broadcast-envelope.js';

// Re-exported: these were this module's public surface before the envelope was
// extracted, and callers (including tests) still read them from here.
export { BROADCAST_BODY_LIMIT, DELIVERY_MAX_LINES, DELIVERY_MAX_CHARS };

const MACHINE_SEPARATOR = '、';

function groupKey(failure) {
  return JSON.stringify([failure.check_name, failure.detail]);
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
  const title = `檢測出現 ${entries.length} 個新問題`;
  const { body, omitted } = renderBody(entries, { limit, maxLines });
  return { title, body, omitted };
}

export default renderAlertMessage;
