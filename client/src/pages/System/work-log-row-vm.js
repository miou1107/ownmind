// v1.26.51 — workLogRowVm(row).
//
// Turns one merged-timeline row (from `GET /api/admin/work-log`) into the
// values a <tr> renders. The four rules that used to live inline in JSX and
// went untested:
//
//   1. Empty details ⇒ `—` in the cell, not the string `{}`.
//   2. summary wins over details when both present (session rows carry both).
//   3. detailsPreview is capped at 200 chars; detailsFull is the whole string
//      (goes into the title attribute for hover).
//   4. user_name falls back to `user#{id}` (a deleted user leaves user_name
//      null after the server's LEFT JOIN).

const SOURCE_COLORS = new Set(['activity', 'compliance', 'session']);
const PREVIEW_MAX = 200;

function isEmptyDetails(details) {
  if (details === null || details === undefined) return true;
  if (typeof details !== 'object') return false;
  return Object.keys(details).length === 0;
}

function detailsString(row) {
  if (row.summary && String(row.summary).length > 0) {
    return String(row.summary);
  }
  if (isEmptyDetails(row.details)) return '';
  return JSON.stringify(row.details);
}

export function workLogRowVm(row) {
  const source = SOURCE_COLORS.has(row.source) ? row.source : 'unknown';
  const userLabel = row.user_name && String(row.user_name).length > 0
    ? row.user_name
    : `user#${row.user_id}`;
  const toolLabel = row.tool && String(row.tool).length > 0 ? row.tool : '—';
  const full = detailsString(row);
  const preview = full.length === 0 ? '—' : full.slice(0, PREVIEW_MAX);
  return {
    sourceColor: source,
    userLabel,
    toolLabel,
    eventLabel: row.event_type,
    timestampIso: row.ts,
    detailsPreview: preview,
    detailsFull: full,
  };
}
