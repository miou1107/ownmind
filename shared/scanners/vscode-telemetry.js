/**
 * shared/scanners/vscode-telemetry.js
 *
 * Cursor and Antigravity are both VSCode-based and use the same state.vscdb
 * shape:
 *   ItemTable(key TEXT, value TEXT)
 *   - telemetry.firstSessionDate
 *   - telemetry.lastSessionDate
 *   - telemetry.currentSessionDate
 *
 * Value is an RFC 2822 string (e.g. "Wed, 04 Mar 2026 09:21:36 GMT").
 *
 * This module provides the shared reader and a pure function turning Date
 * into Asia/Taipei YYYY-MM-DD.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  OK, NO_NEW_ACTIVITY, NO_INSTALL, SQLITE_MISSING, UNREADABLE
} from './reasons.js';

const execFileP = promisify(execFile);

export const TELEMETRY_KEYS = [
  'telemetry.firstSessionDate',
  'telemetry.lastSessionDate',
  'telemetry.currentSessionDate'
];

/**
 * Read the three telemetry keys from state.vscdb as Date objects.
 *
 * @param {{ dbPath: string, sqlitePath?: string, runSqlite?: Function, logger?: object }}
 * @returns {{ firstSessionDate?: Date, lastSessionDate?: Date, currentSessionDate?: Date }}
 */
export async function readVscodeTelemetry({
  dbPath, sqlitePath = 'sqlite3',
  runSqlite = defaultRunSqlite, logger = null
}) {
  const sql = `SELECT key, value FROM ItemTable
                WHERE key IN (${TELEMETRY_KEYS.map(sqlQuote).join(',')})`;
  let rows;
  try {
    rows = await runSqlite({ sqlitePath, dbPath, sql });
  } catch (err) {
    // v1.26.69 — the caller needs to tell "no sqlite3 on this machine" apart from "this
    // database would not open". They are different problems with different fixes, and
    // on Windows the first one is a single command. Both used to return the same {}.
    if (err.code === 'ENOENT') {
      logger?.warn?.(
        `[vscode-telemetry] sqlite3 CLI not found at '${sqlitePath}'. ` +
        `Install: Windows \`winget install SQLite.SQLite\`, ` +
        `Linux \`apt install sqlite3\`, or download from ` +
        `https://www.sqlite.org/download.html — reopen terminal afterwards. ` +
        `Without it, Cursor/Antigravity Tier 2 session_count cannot be collected ` +
        `(Mac has it built in).`
      );
    } else {
      logger?.warn?.(`[vscode-telemetry] sqlite query failed (${dbPath}): ${err.message}`);
    }
    return { failure: err.code === 'ENOENT' ? SQLITE_MISSING : UNREADABLE };
  }

  const out = {};
  for (const r of rows || []) {
    const camel = keyToCamel(r.key);
    const d = new Date(r.value);
    if (camel && !Number.isNaN(d.getTime())) out[camel] = d;
  }
  return out;
}

/**
 * Asia/Taipei YYYY-MM-DD. Pure function.
 */
export function toTaipeiYmd(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(date);
}

/**
 * Generic session_count adapter:
 *   - Read the Taipei-local date matching currentSessionDate.
 *   - If it differs from state[sourceKey].last_session_date → emit one
 *     session record.
 *   - No change → don't resend (UPSERT is idempotent and harmless).
 *
 * v1.26.66 — a tool may write to more than one directory over its lifetime. Antigravity
 * renamed its storage directory from `Antigravity` to `Antigravity IDE`, and the
 * adapter kept reading the abandoned one: a date frozen in the past, no new session to
 * emit, no error anywhere, and a healthy heartbeat every two hours for eleven weeks.
 * Pass `dbPaths` to look in several places and use the freshest.
 *
 * `dbPath` and `dbPaths` mean different things on purpose. `dbPath` is a caller
 * asserting "read this file" and is read directly, exactly as before. `dbPaths` is
 * "find which of these is installed", so its entries are filtered by existence first —
 * otherwise every single-install machine would log a failed query for the sibling
 * directory on every scan, and a warning that fires on healthy machines stops being
 * read.
 *
 * @param {object} opts - { tool, dbPath | dbPaths, sqlitePath, runSqlite, exists,
 *                          scannerVersion, machine, logger }
 * @returns {{tool: string, readSince: Function}}
 */
export function createVscodeAdapter(opts) {
  const {
    tool, dbPath, dbPaths,
    sqlitePath = 'sqlite3', runSqlite = defaultRunSqlite,
    exists = defaultExists,
    extraDateSources = [],
    scannerVersion = 'unknown',
    machine = null,
    logger = null
  } = opts;

  const candidates = dbPaths ?? (dbPath == null ? [] : [dbPath]);
  const skipMissing = dbPaths != null;

  return {
    tool,

    async readSince(state) {
      const sourceKey = tool;  // single global cursor, not per-file
      const prev = state[sourceKey] || {};
      const prevSessionDate = prev.last_session_date || null;

      const { date: cur, failures, looked } = await readFreshestSessionDate({
        candidates, skipMissing, exists, sqlitePath, runSqlite, logger, extraDateSources
      });

      // v1.26.69 — why there is nothing, when there is nothing. The four empty results
      // below used to be one, and telling them apart on a colleague's machine took an
      // hour of manual work on 2026-08-05.
      //
      // The `unreadable` case needs one more question asked. An adapter given a single
      // `dbPath` queries it unfiltered by design (v1.26.66), so on a machine where the
      // tool is simply not installed the CLI answers "unable to open database file" and
      // that arrives here as a failure rather than as an absence. Cursor is such an
      // adapter, so "you do not have Cursor" was reporting as "Cursor is broken".
      let emptyReason = failures.includes(SQLITE_MISSING) ? SQLITE_MISSING
        : failures.includes(UNREADABLE) ? UNREADABLE
          : looked === 0 ? NO_INSTALL
            : NO_NEW_ACTIVITY;

      if (emptyReason === UNREADABLE && !skipMissing && candidates.length > 0) {
        const present = await Promise.all(candidates.map((p) => exists(p)));
        if (!present.some(Boolean)) emptyReason = NO_INSTALL;
      }

      const beat = (reason) => ({
        tool, scanner_version: scannerVersion, machine, reason
      });

      if (!cur) {
        // Nothing to report, and a heartbeat regardless: saying why a collector is
        // quiet must never become a reason for it to go quiet.
        return {
          events: [],
          sessions: [],
          offsetPatch: {},
          cumulativePatch: {},
          reason: emptyReason,
          heartbeat: beat(emptyReason)
        };
      }

      const today = toTaipeiYmd(cur);
      const sessions = [];
      const offsetPatch = {};

      if (today && today !== prevSessionDate) {
        sessions.push({ tool, date: today, count: 1, wall_seconds: 0 });
        offsetPatch[sourceKey] = {
          last_session_date: today,
          last_scan: new Date().toISOString()
        };
      }

      // A date was found. Either it is new (ok) or the day has simply not moved, which
      // is the healthy quiet case and must be distinguishable from every failure.
      const reason = sessions.length > 0 ? OK : NO_NEW_ACTIVITY;

      return {
        events: [],           // Tier 2 has no tokens
        sessions,
        offsetPatch,
        cumulativePatch: {},
        reason,
        heartbeat: beat(reason)
      };
    }
  };
}

// ────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────

/**
 * How far ahead of now a session date may be and still be believed. Timezone handling
 * and ordinary clock drift move things by hours; a rolled-forward system clock moves
 * them by months.
 */
export const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * Latest session Date across the candidate databases, or null.
 *
 * The `currentSessionDate ?? lastSessionDate` fallback is applied *per candidate*
 * before comparing. Comparing currentSessionDate across all candidates first and only
 * then falling back would let a stale install with a currentSessionDate beat a live one
 * that happens to expose only lastSessionDate.
 *
 * A date beyond FUTURE_TOLERANCE_MS is discarded. Taking the maximum blindly means one
 * abandoned database holding a future timestamp wins every comparison forever: it is
 * emitted once, the cursor advances to it, and the live install's real dates are
 * silently suppressed from then on. That converts one dead directory into a dead tool,
 * which is worse than the bug this candidate list exists to fix.
 */
async function readFreshestSessionDate({
  candidates, skipMissing, exists, sqlitePath, runSqlite, logger, extraDateSources = []
}) {
  const ceiling = Date.now() + FUTURE_TOLERANCE_MS;
  let newest = null;
  // v1.26.69 — `failures` is why a read did not happen, `looked` is how many places
  // were actually consulted. Without the second one, "nothing installed here" and
  // "installed and idle" are the same empty answer.
  const failures = [];
  let looked = 0;

  const consider = (d, origin) => {
    if (!d) return;
    if (d.getTime() > ceiling) {
      logger?.warn?.(
        `[vscode-telemetry] ignoring future session date ${d.toISOString()} ` +
        `from ${origin}; the clock that wrote it was wrong`
      );
      return;
    }
    if (newest === null || d > newest) newest = d;
  };

  for (const dbPath of candidates) {
    if (skipMissing && !(await exists(dbPath))) continue;
    looked += 1;
    const t = await readVscodeTelemetry({ dbPath, sqlitePath, runSqlite, logger });
    if (t.failure) failures.push(t.failure);
    // v1.26.68 — both, rather than `currentSessionDate ?? lastSessionDate`. The
    // coalescing version picked the current one whenever it existed and only then let
    // the ceiling judge it, so a database holding a future currentSessionDate beside a
    // perfectly good lastSessionDate contributed nothing: a machine whose clock was
    // wrong once had its telemetry silenced from then on, which is the outcome the
    // ceiling exists to prevent. Offering both is safe because every value goes into
    // one maximum; there is no precedence left to get wrong.
    consider(t.currentSessionDate ?? null, dbPath);
    consider(t.lastSessionDate ?? null, dbPath);
  }

  // v1.26.68 — a tool may have surfaces that are not VSCode applications and write no
  // telemetry at all. Antigravity has two of them. Extra sources answer the same
  // question from somewhere else and are folded in under the same ceiling: a source
  // that could return a bad date is exactly a source that could otherwise poison the
  // cursor permanently.
  for (const source of extraDateSources) {
    let d = null;
    try {
      d = await source();
    } catch (err) {
      // One broken source must not cost the tool its telemetry answer or its heartbeat.
      logger?.warn?.(`[vscode-telemetry] extra session-date source failed: ${err.message}`);
      failures.push(UNREADABLE);
      continue;
    }
    // A source may answer with a bare Date, or with { date, looked } when it can say
    // how many places it actually found. The second form is what stops an installed
    // tool with an empty store from reading as "not installed".
    if (d && typeof d === 'object' && !(d instanceof Date)) {
      looked += Number(d.looked) || 0;
      consider(d.date ?? null, 'an additional session-date source');
    } else {
      if (d) looked += 1;
      consider(d, 'an additional session-date source');
    }
  }

  return { date: newest, failures, looked };
}

/**
 * Whether a candidate database is installed on this machine.
 *
 * Only ENOENT counts as "not installed". Any other failure — a permission wall on a
 * parent directory, an I/O error, a home directory that resolved onto a regular file —
 * means the question could not be answered, and answering "absent" would drop the
 * candidate before sqlite is ever invoked, taking the warning with it. Letting it
 * through costs one failed query and one log line on a machine that is genuinely
 * broken, which is the right side to be wrong on.
 */
export async function defaultExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch (err) {
    return err?.code !== 'ENOENT';
  }
}

function keyToCamel(key) {
  switch (key) {
    case 'telemetry.firstSessionDate':   return 'firstSessionDate';
    case 'telemetry.lastSessionDate':    return 'lastSessionDate';
    case 'telemetry.currentSessionDate': return 'currentSessionDate';
    default: return null;
  }
}

function sqlQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * sqlite3's complaint when it cannot open the database file at all.
 *
 * This is the one failure worth retrying. It is what an editor's `state.vscdb` produces
 * whenever the editor is closed: measured on a Mac on 2026-08-06, `-readonly` succeeds
 * against Cursor's live database while Cursor is running and a `state.vscdb-shm`
 * sidecar sits beside it, and fails on the same bytes copied into an empty directory.
 */
function isCantOpen(err) {
  // stderr when there is one, because `err.message` from execFile begins with the whole
  // command line, path included. A database living under a directory someone named
  // "unable to open database file" would otherwise match on its own path and send every
  // ordinary failure down the fallback.
  const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
  const text = stderr.trim() ? stderr : String(err?.message ?? '');
  return /unable to open database file/i.test(text);
}

/**
 * Run one query with the sqlite3 CLI, falling back to a copy of the database.
 *
 * Tier 2 collection used to depend on the editor happening to be open when the
 * scheduled scan fired: partly luck on the 30-minute Mac schedule, mostly luck on the
 * 120-minute Windows one. The days it missed were absent rather than wrong, so nothing
 * ever reported a problem.
 *
 * The fallback copies the database, with any journal sidecars, and opens the copy with
 * no flags at all. Two measurements shaped that, and neither was the obvious answer:
 *
 *   - A copy retried with `-readonly` fails exactly like the original. What `-readonly`
 *     wants is the `-shm` sidecar, and a bare copy has none either. The first version of
 *     this fix did that and a test against the real CLI caught it.
 *   - These databases are in WAL mode, and the live file really does carry a `-wal`.
 *     Copying only the main file drops whatever has not been checkpointed, which is
 *     precisely the most recent activity a scan is looking for. `immutable=1` has the
 *     same flaw from the other direction: it ignores the WAL by design.
 *
 * An unflagged open on a private copy has neither problem. SQLite owns the snapshot, so
 * it can create the sidecars it needs and replay the WAL, and everything it writes is
 * discarded with the temporary directory. The live file is only ever opened `-readonly`,
 * and that is what keeps this safe.
 *
 * @param {{sqlitePath: string, dbPath: string, sql: string,
 *          execFileFn?: Function, logger?: object}} opts
 */
export async function defaultRunSqlite({
  sqlitePath, dbPath, sql, execFileFn = execFileP, logger = null
}) {
  // `readonly` is never anything but true for the live file. The copy is opened without
  // it so SQLite may create the sidecars it needs and replay the WAL, which it can only
  // do on a database it owns.
  const run = async (target, { readonly = true } = {}) => {
    const args = readonly
      ? ['-json', '-readonly', target, sql]
      : ['-json', target, sql];
    const { stdout } = await execFileFn(sqlitePath, args, { maxBuffer: 10 * 1024 * 1024 });
    const text = String(stdout ?? '').trim();
    if (!text) return [];
    return JSON.parse(text);
  };

  try {
    return await run(dbPath);
  } catch (err) {
    // ENOENT is the CLI itself missing, which v1.26.69 reports as `sqlite_missing` and
    // which on Windows is a one-command fix. Retrying it would take that answer away.
    if (err?.code === 'ENOENT' || !isCantOpen(err)) throw err;
    return await runFromCopy({ run, dbPath, original: err, logger });
  }
}

/**
 * Journal sidecars worth bringing along with a snapshot. A `-wal` left behind by an
 * editor that did not checkpoint holds the newest commits, and a copy without it is a
 * copy of yesterday.
 */
const JOURNAL_SIDECARS = ['-wal', '-shm', '-journal'];

async function runFromCopy({ run, dbPath, original, logger }) {
  let dir = null;
  try {
    // Under the system temporary directory, never beside the original. The collector
    // reads other applications' data; it does not write into their directories.
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ownmind-vscdb-'));
    const copy = path.join(dir, 'snapshot.db');
    await fs.copyFile(dbPath, copy);
    for (const suffix of JOURNAL_SIDECARS) {
      // Absent is the ordinary case: this runs when the editor is closed, and a clean
      // shutdown checkpoints and removes them. A crash does not, and that is the case
      // worth carrying them for.
      await fs.copyFile(`${dbPath}${suffix}`, `${copy}${suffix}`).catch(() => {});
    }
    return await run(copy, { readonly: false });
  } catch (err) {
    // ENOENT here means the source was not there to copy, and that one has to surface as
    // the original: the adapter asks `exists` and turns it into `no_install`, and an fs
    // ENOENT raised from here would be read as "the sqlite3 CLI is missing" instead,
    // because that is what an ENOENT means one level up.
    //
    // Anything else — a full disk, a permission wall on the temp directory, a torn copy
    // that will not parse — is a real failure of its own and says more than a repeated
    // "cannot open" would. It still classifies as `unreadable`; it just says why.
    logger?.warn?.(
      `[vscode-telemetry] ${dbPath} could not be opened read-only, and reading a copy ` +
      `failed too: ${err.message}`
    );
    throw err?.code === 'ENOENT' ? original : err;
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
