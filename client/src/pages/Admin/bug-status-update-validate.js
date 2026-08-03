// v1.26.51 — validateBugStatusUpdate(form).
//
// Mirror of the server guard at src/routes/bug-reports.js:536-557. Client-side
// validation stops an invalid PATCH from hitting the network; the modal shows
// the error inline rather than the toasted server error string.
//
// Returns { ok: true } on success, { ok: false, errorKey: <slug> } on failure.
// The `errorKey` is a stable slug the modal maps to a localised message via
// t('bug_reports.error.<slug>').

const STATUS_ENUM = new Set(['new', 'triaged', 'in_progress', 'fixed', 'wontfix']);
const REASON_ENUM = new Set([
  'by_design',
  'duplicate',
  'low_priority',
  'cannot_reproduce',
  'wontfix_other',
]);

export function validateBugStatusUpdate(form) {
  const status = form?.status;
  if (!STATUS_ENUM.has(status)) {
    return { ok: false, errorKey: 'status' };
  }
  if (status !== 'wontfix') {
    return { ok: true };
  }
  const reason = form.status_reason;
  if (!reason) {
    return { ok: false, errorKey: 'status_reason_required' };
  }
  if (!REASON_ENUM.has(reason)) {
    return { ok: false, errorKey: 'status_reason_enum' };
  }
  if (reason === 'wontfix_other') {
    const note = (form.status_reason_note ?? '').trim();
    if (note.length === 0) {
      return { ok: false, errorKey: 'status_reason_note_required' };
    }
  }
  return { ok: true };
}
