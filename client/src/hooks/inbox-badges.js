/**
 * client/src/hooks/inbox-badges.js
 *
 * v1.32.3 — the pure half of useInboxCount: the shape the rail and the tab strip read,
 * from the server's counts. No React and no api import, so node --test can load it.
 *
 * Null means "show nothing": not loaded yet, failed, or not a number. A real zero is a
 * number, and the components decide not to render zero.
 */
export function inboxBadges(counts) {
  if (!counts || typeof counts !== 'object') return { total: null, byTab: {} };
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const byTab = {
    handoffs: n(counts.handoffs),
    lessons: n(counts.lessons),
    tasks: n(counts.tasks),
    bugs: n(counts.bugs),
  };
  return { total: n(counts.total), byTab };
}
