/**
 * client/src/pages/Portal/handoffs-vm.js
 *
 * v1.33.0 — handoffs, as data. The AI accepts a handoff when a conversation opens in the
 * same project; the page shows what waits and what was taken in the last week, with one
 * undo: 重開. No React and no api import, so node --test can load it.
 */

export const ACCEPTED_WINDOW_DAYS = 7;

/** Pending rows plus the ones accepted in the window; plain `/pending` stays pending-only for the hook. */
export const HANDOFFS_PATH = `/api/handoff/pending?with_accepted=${ACCEPTED_WINDOW_DAYS}`;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pending rows (newest first) and the rows accepted within the window (newest accept
 * first). A row without a status is treated as pending.
 */
export function handoffGroups(rows, now = Date.now()) {
  const list = Array.isArray(rows) ? rows : [];
  const since = now - ACCEPTED_WINDOW_DAYS * DAY_MS;
  const time = (iso) => { const ms = new Date(iso || 0).getTime(); return Number.isFinite(ms) ? ms : 0; };
  const pending = list
    .filter((h) => !h.status || h.status === 'pending')
    .sort((a, b) => time(b.created_at) - time(a.created_at));
  const accepted = list
    .filter((h) => h.status === 'accepted' && time(h.accepted_at) >= since)
    .sort((a, b) => time(b.accepted_at) - time(a.accepted_at));
  return { pending, accepted };
}

/** The row as the server leaves it after reopen: pending again, nobody holding it. */
export function reopenedHandoff(h) {
  return { ...h, status: 'pending', accepted_by: null, accepted_at: null };
}
