// v1.26.50 — per-row view-model for the broadcast list. Pure so the
// rendering rules (which the legacy card encoded inline in JSX) are executed
// by tests.
//
// The load-bearing rules:
//   is_auto row       is never revocable, matching the server guard at
//                     src/routes/broadcast.js:165-169
//   ends_at in past   isActive = false; the row is styled at reduced opacity

const TYPE_COLORS = {
  announcement:     'default',
  maintenance:      'danger',
  rule_change:      'purple',
  upgrade_reminder: 'warning',
};

const SEVERITY_COLORS = {
  info:     'success',
  warning:  'warning',
  critical: 'danger',
};

/**
 * @param {object} row  A broadcast_messages row (from GET /api/broadcast/admin).
 * @param {Date}   now  The clock; injected so tests can pin it.
 */
export function broadcastRowVm(row, now) {
  const nowMs = now.getTime();
  const endsAtMs = row.ends_at ? new Date(row.ends_at).getTime() : null;
  const isActive = endsAtMs === null || endsAtMs > nowMs;
  const isAuto = Boolean(row.is_auto);
  const isRevocable = isActive && !isAuto;

  return {
    id: row.id,
    isActive,
    isAuto,
    isRevocable,
    snoozeLabel: row.allow_snooze ? `${row.snooze_hours}h` : '',
    typeColor: TYPE_COLORS[row.type] || 'default',
    severityColor: SEVERITY_COLORS[row.severity] || 'default',
    startsAtLabel: row.starts_at ? formatLocal(row.starts_at) : '—',
    // null means "permanent"; the caller (the JSX page) supplies the localized
    // "permanent" label. Keeping the string out of the pure function keeps this
    // module free of user-facing text and free of a locale choice.
    endsAtLabel: row.ends_at ? formatLocal(row.ends_at) : null,
  };
}

function formatLocal(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

/**
 * Format the effective-range display line, given the vm and the localized
 * "permanent" label. Split out so the tests can pin the format string against
 * whatever the caller passes.
 *
 * @param {object} vm  Output of broadcastRowVm().
 * @param {string} permanentLabel
 */
export function formatEffectiveRange(vm, permanentLabel) {
  return `${vm.startsAtLabel} — ${vm.endsAtLabel ?? permanentLabel}`;
}
