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

/**
 * v1.26.142 — the three ways a tool used to vanish from the server entirely.
 *
 * Every reason above is produced by an adapter that got far enough to return. The scanner
 * has three outcomes that never reach one, and all three used to end with a line in
 * `~/.ownmind/logs/scanner.log` on the machine with the problem and nothing anywhere else:
 *
 *   - the adapter threw
 *   - the adapter never returned, and the run was abandoned waiting for it
 *   - `OWNMIND_SKIP_TOOLS` dropped it before the loop
 *
 * From the server all three look identical to a member who has never installed that tool,
 * and that is the reading one of them got for six weeks: a member whose whole day is spent
 * in Codex, whose account has never once held a `codex` heartbeat row.
 *
 * A collector that cannot say anything useful still has to say *why* — the principle the
 * codes above already follow. These extend it to the runs where the adapter is the thing
 * that failed.
 */
/** The adapter threw. `heartbeat.error` carries the message. */
export const ADAPTER_ERROR = 'adapter_error';
/** The adapter did not return within the per-tool deadline. */
export const ADAPTER_TIMEOUT = 'adapter_timeout';
/** OWNMIND_SKIP_TOOLS named this tool, so it was never scanned. */
export const SKIPPED_BY_CONFIG = 'skipped_by_config';

export const REASONS = new Set([
  OK, NO_NEW_ACTIVITY, NO_INSTALL, SQLITE_MISSING, UNREADABLE, ACCOUNT_CHANGED,
  ADAPTER_ERROR, ADAPTER_TIMEOUT, SKIPPED_BY_CONFIG
]);

/**
 * Reasons that mean the collector itself failed, as opposed to having nothing to report.
 *
 * The server writes an audit row for these and only these. Letting any heartbeat carry
 * free text into the audit table would turn it back into the log file this replaces.
 */
export const COLLECTOR_FAILURES = new Set([ADAPTER_ERROR, ADAPTER_TIMEOUT]);

/**
 * Whether a reason means the collector broke rather than having nothing to send.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isCollectorFailure(v) {
  return typeof v === 'string' && COLLECTOR_FAILURES.has(v);
}

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
