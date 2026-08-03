// v1.26.51 — bugReportRowVm(row, userMap).
//
// The legacy tab encoded severity / status / user-map / timestamp rules inline
// in template strings, so nothing ran them under test. Pulled out here so the
// four small rules are executed by tests/bug-report-row-vm.test.js.
//
// Keep the shape flat — the JSX doesn't want a nested object.

const SEVERITY_COLORS = new Set(['low', 'medium', 'high', 'critical']);
const STATUS_COLORS = new Set(['new', 'triaged', 'in_progress', 'fixed', 'wontfix']);

function truncateTimestamp(iso) {
  if (!iso) return '';
  // Matches the legacy `slice(0, 16).replace('T', ' ')`: minute precision.
  return String(iso).slice(0, 16).replace('T', ' ');
}

export function bugReportRowVm(row, userMap = {}) {
  const severity = SEVERITY_COLORS.has(row.severity) ? row.severity : 'medium';
  const status = STATUS_COLORS.has(row.status) ? row.status : 'new';
  const userLabel = userMap[row.user_id] || `user#${row.user_id}`;
  const component = row.component && row.component.length > 0 ? row.component : '—';
  return {
    id: row.id,
    title: row.title,
    severityColor: severity,
    statusColor: status,
    statusLabel: row.status || 'new',
    userLabel,
    componentLabel: component,
    createdAtLabel: truncateTimestamp(row.created_at),
  };
}
