/**
 * shared/scanners/sqlite-cli.js
 *
 * One way to run a query against another application's SQLite database.
 *
 * Every adapter that reads a database it does not own goes through here. Two of them
 * used to assemble their own `execFile` arguments, v1.26.70 fixed one, and v1.26.71 was
 * the other one turning out to have the identical defect. A note saying "remember the
 * other copy" is not a fix; one function is.
 *
 * The rule the whole module exists to keep: **another application's file is only ever
 * opened `-readonly`.** Everything below is about staying inside that rule while still
 * being able to read a database whose application is closed.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execFileP = promisify(execFile);

/** Enough for three telemetry rows. A Tier 1 scan passes its own; see runSqliteCli. */
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Is this database there at all?
 *
 * Every caller needs this for the same reason: `sqlite3` answers "unable to open database
 * file" both for a database whose application is closed and for a path with nothing at
 * it, and those are opposite answers. One is "your tool is broken", the other is "you do
 * not run this tool".
 *
 * Only ENOENT counts as absent. Anything else — EACCES on a parent directory, an I/O
 * error, a home directory that resolved onto a regular file — means the question could
 * not be answered, and answering "absent" would hide a genuinely broken machine behind
 * "not installed".
 */
// v1.26.119 — `access` is injectable so the rule below can be asserted without conjuring a
// real OS error. It could not be: the one shape the tests used, a regular file standing in
// for a directory, gives ENOTDIR on POSIX and **ENOENT on Windows** (measured on TANK, along
// with illegal characters, reserved device names and over-long paths — every one of them
// ENOENT). So on Windows the case read as "absent", the test failed, and the product was
// right the whole time: the OS itself answers "nothing there". The rule is what matters and
// the rule is now testable everywhere; the real-OS cases stay where they can be produced.
export async function databaseExists(p, { access = fs.access } = {}) {
  try {
    await access(p);
    return true;
  } catch (err) {
    return err?.code !== 'ENOENT';
  }
}

/**
 * Journal sidecars worth bringing along with a snapshot. A `-wal` left behind by an
 * application that did not checkpoint holds the newest commits, and a copy without it is
 * a copy of yesterday.
 */
export const JOURNAL_SIDECARS = ['-wal', '-shm', '-journal'];

/**
 * sqlite3's complaint when it cannot open the database file at all.
 *
 * This is the one failure worth retrying. It is what a database produces whenever its
 * application is closed: measured on a Mac on 2026-08-06, `-readonly` succeeds against
 * Cursor's live database while Cursor is running and a `state.vscdb-shm` sidecar sits
 * beside it, and fails on the same bytes copied into an empty directory. OpenCode's
 * `opencode.db` behaves identically, and `PRAGMA journal_mode` on it returns `wal`.
 */
export function isCantOpen(err) {
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
 * Collection used to depend on the application happening to be open when the scheduled
 * scan fired: partly luck on the 30-minute Mac schedule, mostly luck on the 120-minute
 * Windows one. The days it missed were absent rather than wrong, so nothing ever
 * reported a problem.
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
 * discarded with the temporary directory.
 *
 * @param {{sqlitePath: string, dbPath: string, sql: string, maxBuffer?: number,
 *          execFileFn?: Function, logger?: object}} opts
 */
export async function runSqliteCli({
  sqlitePath, dbPath, sql,
  maxBuffer = DEFAULT_MAX_BUFFER, execFileFn = execFileP, logger = null
}) {
  // `readonly` is never anything but true for the live file. The copy is opened without
  // it so SQLite may create the sidecars it needs and replay the WAL, which it can only
  // do on a database it owns.
  const run = async (target, { readonly = true } = {}) => {
    const args = readonly
      ? ['-json', '-readonly', target, sql]
      : ['-json', target, sql];
    const { stdout } = await execFileFn(sqlitePath, args, { maxBuffer });
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

async function runFromCopy({ run, dbPath, original, logger }) {
  let dir = null;
  try {
    // Under the system temporary directory, never beside the original. The collector
    // reads other applications' data; it does not write into their directories.
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ownmind-sqlite-'));
    const copy = path.join(dir, 'snapshot.db');
    await fs.copyFile(dbPath, copy);
    for (const suffix of JOURNAL_SIDECARS) {
      // Absent is the ordinary case: this runs when the application is closed, and a
      // clean shutdown checkpoints and removes them. A crash does not, and that is the
      // case worth carrying them for.
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
      `[sqlite-cli] ${dbPath} could not be opened read-only, and reading a copy ` +
      `failed too: ${err.message}`
    );
    throw err?.code === 'ENOENT' ? original : err;
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
