// v1.26.51 — buildWorkLogQuery(filters, offset, limit).
//
// Turns the filter state + pagination into URLSearchParams for
// `GET /api/admin/work-log/`. The date widening lives here so it's covered
// by tests; the legacy JS had that logic inline and it was easy to break
// silently.
//
// Contract:
//   - filters is an object with optional keys: from, to, source, user_id,
//     tool, event_type, q
//   - `from` / `to` accept YYYY-MM-DD and get widened to start/end of day UTC
//   - empty strings and undefined are OMITTED, not passed as empty (a
//     `user_id=` in the URL would trip the server's parseInt)
//   - `q` is trimmed; whitespace-only is dropped
//   - limit and offset are always set

export function buildWorkLogQuery(filters = {}, offset = 0, limit = 100) {
  const p = new URLSearchParams();

  const from = filters.from ? String(filters.from).trim() : '';
  if (from) p.set('from', `${from}T00:00:00.000Z`);

  const to = filters.to ? String(filters.to).trim() : '';
  if (to) p.set('to', `${to}T23:59:59.999Z`);

  const src = filters.source ? String(filters.source).trim() : '';
  if (src) p.set('source', src);

  if (filters.user_id !== undefined && filters.user_id !== null) {
    const uid = String(filters.user_id).trim();
    if (uid) p.set('user_id', uid);
  }

  const tool = filters.tool ? String(filters.tool).trim() : '';
  if (tool) p.set('tool', tool);

  const et = filters.event_type ? String(filters.event_type).trim() : '';
  if (et) p.set('event_type', et);

  const q = filters.q ? String(filters.q).trim() : '';
  if (q) p.set('q', q);

  p.set('limit', String(limit));
  p.set('offset', String(offset));

  return p;
}
