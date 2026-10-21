/**
 * client/src/pages/Portal/tasks-vm.js
 *
 * v1.33.0 — task cards, as data. A card the AI finished with evidence is closed; nobody
 * reviews it. The pages show closed cards under 「本月結案」 with one undo: 退回 (reopen).
 * No React and no api import, so node --test can load it.
 */

const CLOSED = new Set(['done', 'reviewed']);

/** The person's cards still moving (the server leaves closed ones out). */
export const TASKS_MINE_PATH = '/api/tasks?mine=true&full=true';
/** The person's cards closed this month, for the 本月結案 section. */
export const TASKS_CLOSED_PATH = '/api/tasks?mine=true&full=true&closed=month';

/** True when the card is closed and may be sent back to open. */
export function canReopen(card) {
  return CLOSED.has(card?.status);
}

/** The person's own cards: the ones still moving, and the ones closed (this month's report). */
export function splitTasks(items) {
  const list = Array.isArray(items) ? items : [];
  return {
    active: list.filter((c) => !CLOSED.has(c.status)),
    closed: list.filter((c) => CLOSED.has(c.status)),
  };
}

/**
 * The team page's sections, in the order a reader scans them: what is being worked on,
 * what waits for an AI, what closed, what came back. Empty sections are dropped.
 */
export function teamTaskGroups(items) {
  const list = Array.isArray(items) ? items : [];
  return [
    { id: 'claimed', labelKey: 'tasks.status.claimed', cards: list.filter((c) => c.status === 'claimed') },
    { id: 'open', labelKey: 'tasks.status.open', cards: list.filter((c) => c.status === 'open') },
    { id: 'closed', labelKey: 'tasks.closed_section', cards: list.filter((c) => CLOSED.has(c.status)) },
    { id: 'dropped', labelKey: 'tasks.status.dropped', cards: list.filter((c) => c.status === 'dropped') },
  ].filter((g) => g.cards.length > 0);
}

/** The card as the server leaves it after reopen: open again, with the result cleared. */
export function reopenedCard(card) {
  return {
    ...card,
    status: 'open',
    claimed_by: null,
    claimed_at: null,
    holder_name: null,
    held_by_me: false,
    result: null,
    evidence: null,
    done_at: null,
    reviewed_by: null,
    reviewed_at: null,
  };
}

/**
 * After 退回 on the personal page: the card leaves 本月結案 and joins the moving cards as
 * open. A card not in the closed list (already moved) is left where it is.
 */
export function moveReopened({ active, closed }, id) {
  const card = (closed || []).find((c) => c.id === id);
  if (!card) return { active: active || [], closed: closed || [] };
  return {
    active: [reopenedCard(card), ...(active || [])],
    closed: closed.filter((c) => c.id !== id),
  };
}

/** The error key for a failed reopen, so the page never shows a raw status. */
export function reopenErrorKey(r) {
  if (r?.status === 409) return 'tasks.reopen_not_closed';
  if (r?.status === 403) return 'tasks.reopen_not_yours';
  return 'tasks.action_error';
}
