/**
 * shared/scanners/selfcheck.js
 *
 * "I sent it" and "the server has it" are different claims, and only the second one is
 * worth anything.
 *
 * Every collector defect found in the week before this was written had the same shape:
 * the machine believed it was working, the server had nothing, and no layer said so. The
 * evidence needed to diagnose each one existed only on the machine with the problem, and
 * nobody was looking at it there.
 *
 * This module turns "what this machine just scanned" plus "what the server says it now
 * holds" into a verdict per tool. The comparison is pure and the fetch is separate, so
 * the interesting half is testable without a server.
 */

import {
  NO_INSTALL, SQLITE_MISSING, UNREADABLE, ADAPTER_ERROR, ADAPTER_TIMEOUT
} from './reasons.js';

/**
 * How recent a heartbeat has to be to count as "this run landed".
 *
 * Generous on purpose. The scan runs immediately before the check, so the true gap is
 * seconds; the window only has to exclude a row left by a previous run, and a collector
 * that died months ago must not read as proof.
 */
export const FRESH_WINDOW_MS = 10 * 60 * 1000;

const FETCH_TIMEOUT_MS = 15 * 1000;

/** Long enough that a match is the key and not a coincidence. */
const MIN_REDACTABLE_KEY = 8;

function redactKey(text, apiKey) {
  let out = String(text ?? '');
  if (apiKey && String(apiKey).length >= MIN_REDACTABLE_KEY) {
    out = out.split(apiKey).join('***');
  }
  return out.replace(/([?&](?:api[-_]?key|key|token)=)[^&\s]+/gi, '$1***');
}

/**
 * Ask the server what it holds for this account.
 *
 * Errors are returned, not thrown. This runs at the end of an installation, and a
 * diagnostic that can fail an install is a worse defect than the one it detects.
 *
 * @returns {{ok: true, data: object} | {ok: false, error: string}}
 */
export async function fetchSelfCheck({
  apiUrl, apiKey, fetchFn = fetch, timeoutMs = FETCH_TIMEOUT_MS
}) {
  // Redacted here, where the key is known, rather than trusting every caller to do it.
  // Measured: a key containing a newline makes fetch throw
  // `Headers.append: "<the key>" is an invalid header value` — the message carries the
  // key verbatim.
  const hide = (text) => redactKey(text, apiKey);
  const url = `${String(apiUrl).replace(/\/+$/, '')}/api/usage/self-check`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      // `Authorization: Bearer` is the only thing src/middleware/auth.js reads. This sent
      // `X-API-Key` from v1.26.72 to v1.26.76 and every real call answered 401; the one
      // run before that had hit a server old enough to answer 404, which looked like a
      // different problem and hid this one.
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (!res.ok) {
      // 404 is its own answer and worth naming: the server is older than this check.
      return { ok: false, error: res.status === 404
        ? 'this server does not have the self-check endpoint yet (it needs v1.26.72 or newer)'
        : `the server answered ${res.status}` };
    }
    const data = await res.json();
    if (!data || !Array.isArray(data.tools) || !data.server_time) {
      return { ok: false, error: 'the server\'s answer was not in the expected shape' };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError'
      ? `no answer from the server within ${Math.round(timeoutMs / 1000)}s`
      : hide(err?.message ?? String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

export const CONFIRMED = 'confirmed';
export const NOT_INSTALLED = 'not_installed';
export const OTHER_MACHINE = 'other_machine';
export const UNATTRIBUTED = 'unattributed';
export const NOT_RECORDED = 'not_recorded';
export const BLOCKED = 'blocked';

/** Verdicts that mean somebody has to do something. */
const FAILING = new Set([NOT_RECORDED, BLOCKED]);
const WARNING = new Set([OTHER_MACHINE, UNATTRIBUTED]);

/**
 * Reasons that mean the machine could not read the tool, so nothing was ever sent.
 *
 * v1.26.142 — the two collector-failure codes belong here, and the reason is subtle enough
 * to be worth stating. `verdictFor` consults the server only after this set, and since
 * v1.26.142 a crashed adapter *does* leave a fresh heartbeat behind. Without these two
 * entries a tool that failed on every run would satisfy "the server has a recent row from
 * this machine" and report `confirmed` — the check would read its own failure notice as
 * proof of success.
 */
const LOCAL_BLOCKERS = new Set([UNREADABLE, SQLITE_MISSING, ADAPTER_ERROR, ADAPTER_TIMEOUT]);

/**
 * Two hostnames for the same computer. Windows reports it upper-cased on some paths, and
 * a name that arrives with surrounding space would otherwise read as a second machine.
 *
 * Returns null when either side cannot say. That case used to answer "same", on the
 * reasoning that unknown is not somebody else — and it produced exactly the outcome this
 * module exists to prevent. `collector_heartbeat` is UNIQUE (user_id, tool), so there is
 * one row per tool for the whole account: a fresh row with no machine name is
 * indistinguishable from another computer's, and a machine whose upload is silently
 * failing would read its neighbour's heartbeat as proof of its own success.
 */
function sameMachine(a, b) {
  if (a == null || b == null) return null;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Compare what this machine just did with what the server says it holds.
 *
 * @param {object} opts
 * @param {string} opts.machine        this computer's hostname
 * @param {Array}  opts.scanned        [{ tool, sent, accepted, sessions, reason }]
 * @param {Array}  opts.serverTools    heartbeat rows from GET /api/usage/self-check
 * @param {string} opts.serverTime     the server's clock, from the same response
 * @param {number} [opts.freshWindowMs]
 * @returns {{ok: boolean, failures: number, warnings: number, rows: Array}}
 */
export function buildSelfCheckReport({
  machine, scanned = [], serverTools = [], serverTime,
  freshWindowMs = FRESH_WINDOW_MS
}) {
  // The server's own clock, never this machine's. A wrong local clock would report a
  // healthy collector as broken or a dead one as healthy, and it is exactly the machine
  // you cannot ask.
  const serverNow = new Date(serverTime).getTime();

  // v1.26.73 — the server now holds one row per (tool, machine), so a tool can come back
  // several times for one account. **This machine's own row is the only one that answers
  // the question**, and picking by tool alone would let a sibling computer's fresh
  // heartbeat stand in for a silence here. Keep any other machine's row as the fallback,
  // so a tool with nothing from this machine still reports `other_machine` rather than
  // "the server has never heard of it".
  const byTool = new Map();
  for (const row of serverTools) {
    if (!row?.tool) continue;
    const held = byTool.get(row.tool);
    if (!held || (sameMachine(row.machine, machine) === true
      && sameMachine(held.machine, machine) !== true)) {
      byTool.set(row.tool, row);
    }
  }

  const rows = scanned.map((s) => {
    const server = byTool.get(s.tool) ?? null;
    const reportedAt = server?.last_reported_at
      ? new Date(server.last_reported_at).getTime() : null;
    const fresh = Number.isFinite(serverNow) && Number.isFinite(reportedAt)
      && (serverNow - reportedAt) <= freshWindowMs;

    return {
      tool: s.tool,
      verdict: verdictFor({ scan: s, server, fresh, machine }),
      reason: s.reason ?? null,
      sent: s.sent ?? 0,
      accepted: s.accepted ?? 0,
      server_machine: server?.machine ?? null,
      server_last_reported_at: server?.last_reported_at ?? null,
      server_events_24h: server?.events_24h ?? null
    };
  });

  return {
    rows,
    failures: rows.filter((r) => FAILING.has(r.verdict)).length,
    warnings: rows.filter((r) => WARNING.has(r.verdict)).length,
    ok: rows.every((r) => !FAILING.has(r.verdict))
  };
}

function verdictFor({ scan, server, fresh, machine }) {
  // Order matters. The machine's own answer comes first, because it knows something the
  // server cannot: whether it had anything to send and whether it could read at all.
  if (scan.reason === NO_INSTALL) return NOT_INSTALLED;
  if (LOCAL_BLOCKERS.has(scan.reason)) return BLOCKED;
  if (!server || !fresh) return NOT_RECORDED;
  const same = sameMachine(server.machine, machine);
  if (same === null) return UNATTRIBUTED;
  return same ? CONFIRMED : OTHER_MACHINE;
}

/**
 * One line per tool, for whoever is watching the installer finish.
 *
 * A failure has to carry the next thing to do. A person reading "not_recorded" and
 * nothing else has learned that something is wrong and not what to do about it, which is
 * the state this whole change exists to get out of.
 */
export function renderSelfCheckReport(report, { serverLabel = 'the server' } = {}) {
  const lines = [];
  for (const r of report.rows) {
    lines.push(`  ${symbolFor(r.verdict)} ${r.tool.padEnd(14)} ${describe(r, serverLabel)}`);
  }
  if (report.rows.length === 0) {
    lines.push('  (no tools were scanned on this machine)');
  } else if (report.ok && report.warnings === 0) {
    lines.push('');
    lines.push(`  All good. ${serverLabel} has this machine's usage data.`);
  } else if (report.ok) {
    lines.push('');
    lines.push('  Usage is being collected. See the note above about another computer.');
  } else {
    lines.push('');
    lines.push(`  ${report.failures} tool(s) are not reaching ${serverLabel}. `
      + 'The line above each says what to do.');
  }
  return lines.join('\n');
}

function symbolFor(verdict) {
  if (FAILING.has(verdict)) return '[FAIL]';
  if (WARNING.has(verdict)) return '[WARN]';
  return '[ OK ]';
}

function describe(r, serverLabel) {
  switch (r.verdict) {
    case CONFIRMED:
      return r.sent > 0
        ? `${serverLabel} recorded ${r.accepted} new event(s) from this machine.`
        : `${serverLabel} has this machine's check-in. Nothing new to send.`;
    case NOT_INSTALLED:
      return 'not installed on this machine, so there is nothing to collect.';
    case UNATTRIBUTED:
      return `${serverLabel} has a recent check-in for this tool but no record of which `
        + 'computer sent it, so this one cannot be confirmed from here. Upgrade every '
        + 'computer on this account, then run this check again.';
    case OTHER_MACHINE:
      return `${serverLabel} currently records this tool against "${r.server_machine}", `
        + 'not this computer. Usage still counts for you; which computer it came from '
        + 'does not. Nothing to fix on this machine.';
    case BLOCKED:
      return r.reason === SQLITE_MISSING
        ? 'the sqlite3 command is missing on this machine. Windows: '
          + '`winget install SQLite.SQLite`, Linux: `apt install sqlite3`, then reopen '
          + 'the terminal and run this check again.'
        : 'this machine could not read the tool\'s data. Close the application '
          + 'completely and run this check again; if it persists, send '
          + '~/.ownmind/logs/scanner.log.';
    case NOT_RECORDED:
    default:
      return `this machine scanned it and ${serverLabel} has no recent record from here. `
        + 'Check the network and that the api key in ~/.claude/settings.json is current, '
        + 'then run this check again.';
  }
}
