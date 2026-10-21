/**
 * client/src/pages/Portal/lessons-vm.js
 *
 * v1.33.0 — the lessons page, as data. The AI decides which lessons become memories (on
 * a repeat, or at the monthly pass); the page only shows what it decided and offers one
 * undo per row.
 * No React and no api import, so node --test can load it.
 */

/** The reason the server stores on the memory when the person takes a kept lesson back. */
export const RETRACT_REASON = '從教訓頁收回';

/** How many days back the page lists; the server applies the window on created_at. */
export const LESSONS_WINDOW_DAYS = 60;

export const LESSONS_PATH = `/api/session/lessons?status=all&days=${LESSONS_WINDOW_DAYS}`;

/**
 * One row's state and its single action.
 *
 * - promoted  → 「AI 留下了」, action `retract` (archive the memory it made)
 * - dismissed → 「AI 沒留：<reason>」, action `keep` (promote now)
 * - new       → 「等月底整理」, action `keep`
 */
export function lessonRow(l) {
  const status = l.status === 'promoted' || l.status === 'dismissed' ? l.status : 'new';
  const reason = typeof l.reason === 'string' ? l.reason.trim() : '';
  return {
    id: l.id,
    status,
    stateKey: status === 'promoted' ? 'lessons.state.promoted'
      : status === 'dismissed' ? (reason ? 'lessons.state.dismissed' : 'lessons.state.dismissed_no_reason')
      : 'lessons.state.new',
    reason,
    memoryId: Number.isInteger(l.memory_id) ? l.memory_id : null,
    action: status === 'promoted' ? 'retract' : 'keep',
    actionKey: status === 'promoted' ? 'lessons.retract' : 'lessons.keep',
  };
}

/**
 * The list after the server accepted an action on one row.
 *
 * `retract` leaves the lesson dismissed with the retract reason: the memory it made is
 * archived, so showing it as still kept would be a lie. `keep` marks it promoted and
 * carries the new memory id when the server returned one.
 */
export function applyLessonAction(items, id, action, result) {
  return items.map((l) => {
    if (l.id !== id) return l;
    if (action === 'retract') return { ...l, status: 'dismissed', reason: RETRACT_REASON, memory_id: null };
    const memoryId = Number.isInteger(result?.memory_id) ? result.memory_id : l.memory_id ?? null;
    return { ...l, status: 'promoted', reason: null, memory_id: memoryId };
  });
}

/** The row-level error key for a failed action, so the page never shows a raw status. */
export function lessonErrorKey(r) {
  if (r?.status === 409) return 'lessons.already_resolved';
  if (r?.status === 404) return 'lessons.gone';
  if (r?.status === 400 && r?.data?.rule) return 'lessons.secret_refused';
  return 'lessons.action_error';
}
