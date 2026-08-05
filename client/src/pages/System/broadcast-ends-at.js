// v1.26.62 — the two conversions the 新增廣播 end-time field needs.
//
// `<input type="datetime-local">` speaks `YYYY-MM-DDTHH:mm` with no timezone;
// `POST /api/broadcast/admin` speaks ISO 8601. These functions are the bridge,
// kept pure so both directions are testable without a browser
// (tests/broadcast-ends-at.test.js).
//
// The load-bearing detail: per ES2016, `new Date()` reads a date-time form
// carrying no offset as *local* time, which is exactly how the browser reads
// the field. So converting is `new Date(value).toISOString()` and nothing
// more — no manual offset arithmetic, which is where this class of bug
// usually lives.

const DEFAULT_DAYS = 30;

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * The value the dialog prefills: `DEFAULT_DAYS` after `now`, formatted for the
 * input element. `now` is a parameter rather than a `new Date()` inside so the
 * test can pin it.
 *
 * @param {Date} now
 * @returns {string} `YYYY-MM-DDTHH:mm`, no timezone suffix.
 */
export function defaultEndsAtLocal(now) {
  // setDate, not `+ 30 * 86400000`. The label says "30 days", and a person
  // reading it expects the same time of day. Adding a fixed number of
  // milliseconds adds exactly 720 hours instead, so in a zone with daylight
  // saving a dialog opened at 09:15 would prefill 10:15. Taipei and Tokyo have
  // no DST, but this console ships in English and Japanese, and the arithmetic
  // should mean what the label says regardless of who reads it.
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + DEFAULT_DAYS);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * @param {string} local  A value straight off the input element.
 * @returns {string|null} ISO 8601 with an offset, or null when the field names
 *   no moment — empty, blank, or unparseable. The caller uses one falsy check
 *   to mean "permanent", so all of those must collapse to the same value.
 */
export function localToIso(local) {
  const raw = String(local ?? '').trim();
  if (raw === '') return null;
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}
