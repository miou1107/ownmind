/**
 * shared/scanners/reasons.js — why a collector had nothing to send.
 *
 * v1.26.69. v1.26.50 separated the honest states in the console: `flowing`, `silent`,
 * `not_installed`, `offline`. `silent` means "the heartbeat arrives and no usage rows
 * do", and it has at least five causes that look identical from the server:
 *
 *   - the sqlite3 CLI is missing, so Tier 2 cannot be read at all
 *   - the tool is not installed on that machine
 *   - the tool is installed but has not been used
 *   - the collector is reading a directory the tool abandoned (v1.26.66)
 *   - the machine changed account, so the cursor says the day was already reported
 *
 * The collector knows which one applies at the moment it gives up. Until now it wrote
 * that to a local log file and sent the server the word "active".
 *
 * The set is closed deliberately. A free-text field becomes a log line, and a log line
 * is what this exists to replace.
 */

/** Read cleanly and had something to send. */
export const OK = 'ok';
/** Read cleanly; nothing new since the last scan. The healthy quiet case. */
export const NO_NEW_ACTIVITY = 'no_new_activity';
/** Nothing belonging to this tool exists on this machine. */
export const NO_INSTALL = 'no_install';
/** The sqlite3 CLI could not be executed, so this tool cannot be read at all. */
export const SQLITE_MISSING = 'sqlite_missing';
/** The data is there and could not be opened. */
export const UNREADABLE = 'unreadable';
/** The cursor belonged to a different account and was reset this run. */
export const ACCOUNT_CHANGED = 'account_changed';

export const REASONS = new Set([
  OK, NO_NEW_ACTIVITY, NO_INSTALL, SQLITE_MISSING, UNREADABLE, ACCOUNT_CHANGED
]);

/**
 * Whether a value is one of the codes. Used at the server boundary, where anything a
 * client sends has to be checked before it reaches a sized column.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isReason(v) {
  return typeof v === 'string' && REASONS.has(v);
}
