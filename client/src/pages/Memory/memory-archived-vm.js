/**
 * client/src/pages/Memory/memory-archived-vm.js
 *
 * v1.33.0 — the archived memories tab, as data: the project memories the AI archived
 * while keeping the store, newest archive first, each with the reason it gave. No React and no api import,
 * so node --test can load it.
 */

/** The rows out of whatever envelope the route answers with (a bare array or `{data}`). */
export function archivedPayloadRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

export function archivedRow(m) {
  return {
    id: m.id,
    title: m.title || `#${m.id}`,
    content: m.content ?? '',
    project: typeof m.project === 'string' ? m.project : '',
    reason: typeof m.archived_reason === 'string' ? m.archived_reason.trim() : '',
    archivedAt: m.archived_at ?? m.updated_at ?? null,
  };
}

/** Newest archive first; a row without a date sorts last. */
export function archivedRows(rows) {
  const time = (iso) => { const ms = new Date(iso || 0).getTime(); return Number.isFinite(ms) ? ms : 0; };
  return archivedPayloadRows(rows).map(archivedRow).sort((a, b) => time(b.archivedAt) - time(a.archivedAt));
}
