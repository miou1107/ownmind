/**
 * v1.26.124 — one definition of "today", shared by every program that writes a daily file
 * or decides whether today's work has already been done.
 *
 * The project already had this rule, written into mcp/ownmind-log.js by v1.20.1:
 *
 *   "Per timezone discipline, OwnMind defines 'today' in the user's local timezone."
 *
 * The MCP followed it. So did the two shell hooks, which use `date +%Y-%m-%d`. The Node
 * hooks did not: they called `new Date().toISOString().slice(0, 10)`, which is UTC.
 *
 * Measured on a UTC+8 machine at 07:13 local on 2026-08-10, with all of it live at once:
 *
 *     ~/.ownmind/.last-update-check   2026-08-09   (written by the Node hook, UTC)
 *     date -u +%Y-%m-%d               2026-08-09   -> Node hook: "already checked today"
 *     date    +%Y-%m-%d               2026-08-10   -> shell hook: "not checked yet"
 *
 * Both hooks are registered on that machine — Claude Code runs the Node one, Gemini CLI the
 * shell one — so between local midnight and 08:00 they disagree about whether the daily
 * update has run. Whichever runs second redoes the work and rewrites the marker, which
 * flips the disagreement to the other side for the next session. Two programs deciding to
 * update at the same moment is also the one thing the update lock exists to survive.
 *
 * The same 8-hour window split the event log in two: hook-written events landed in
 * yesterday's YYYY-MM-DD.jsonl while MCP-written events landed in today's, so "today's log"
 * held half the story for a third of every day.
 *
 * None of this is visible where the clocks agree. A machine in UTC — CI, or a server —
 * has local == UTC, so both branches return the same string and the bug cannot reproduce.
 * That is why it survived: the only place it happens is a developer's own machine.
 */

/**
 * The calendar date in the local timezone, as YYYY-MM-DD.
 *
 * Deliberately not `toISOString().slice(0, 10)`: that is the UTC date, which is a different
 * day from the user's for part of every day at any non-zero offset.
 *
 * @param {Date} [date] defaults to now
 * @returns {string}
 */
export function localDateOnly(date = new Date()) {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

/**
 * An ISO 8601 timestamp carrying the local UTC offset, e.g. 2026-08-10T07:13:15+08:00.
 *
 * Same instant as the UTC form and unambiguous to any correct parser; the point is that its
 * date half agrees with localDateOnly, so a line's timestamp and the name of the file it
 * was written into no longer describe different days.
 *
 * @param {Date} [date] defaults to now
 * @returns {string}
 */
export function localIsoTimestamp(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0');
  const mm = String(Math.abs(offsetMinutes) % 60).padStart(2, '0');
  return localDateOnly(date) + 'T' +
    String(date.getHours()).padStart(2, '0') + ':' +
    String(date.getMinutes()).padStart(2, '0') + ':' +
    String(date.getSeconds()).padStart(2, '0') + '.' +
    String(date.getMilliseconds()).padStart(3, '0') +
    sign + hh + ':' + mm;
}
