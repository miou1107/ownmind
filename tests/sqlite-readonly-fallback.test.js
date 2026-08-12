// v1.26.70 — Tier 2 could only read state.vscdb while the editor was running.
//
// Isolated on a Mac on 2026-08-06 with a controlled test. Copying the database into an
// empty directory, so no -shm or -wal sidecar sits beside it:
//
//   sqlite3 -json -readonly "<copy>"          -> unable to open database file (14)
//   sqlite3 -json "file:<copy>?immutable=1"   -> reads fine
//
// Against the live file, the same -readonly command succeeds while Cursor is running
// and a state.vscdb-shm sidecar exists. Close the editor and the sidecar goes with it.
//
// So collection depended on the editor happening to be open when the scheduled scan
// fired: partly luck on the 30-minute Mac schedule, mostly luck on the 120-minute
// Windows one. The missed days were absent rather than wrong, which is why no layer
// ever flagged it.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import nodePath from 'path';
import nodeOs from 'os';
import { tempDir } from './helpers/temp-dir.js';
const { defaultRunSqlite } = await import('../shared/scanners/vscode-telemetry.js');

/** The copy is passed as a plain path, so this is identity; kept for readability. */
const asPath = (arg) => String(arg);

const ROWS = [{ key: 'telemetry.currentSessionDate', value: 'Wed, 05 Aug 2026 17:10:43 GMT' }];

/** The shape execFile rejects with when the sqlite3 CLI exits non-zero. */
function cantOpen() {
  const err = new Error('Command failed: sqlite3 ...\n'
    + 'Error: in prepare, unable to open database file (14)\n');
  err.code = 1;
  err.stderr = 'Error: in prepare, unable to open database file (14)\n';
  return err;
}

function cliMissing() {
  const err = new Error('spawn sqlite3 ENOENT');
  err.code = 'ENOENT';
  return err;
}

let ROOT;
before(async () => {
  ROOT = await tempDir('ownmind-sqlite-fb-');
});
after(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
});

let seq = 0;
async function aDatabase(contents = 'SQLite format 3\0fake') {
  const p = nodePath.join(ROOT, `db-${seq += 1}.vscdb`);
  await fsp.writeFile(p, contents);
  return p;
}

/**
 * An execFile stand-in. `openable` is the set of paths it will read; anything else
 * fails the way a closed editor's database fails.
 */
function fakeExecFile(openable) {
  const calls = [];
  const fn = async (bin, args) => {
    const dbPath = args[args.length - 2];
    calls.push({ bin, args, dbPath });
    if (!openable.has(dbPath)) throw cantOpen();
    return { stdout: JSON.stringify(ROWS) };
  };
  return { fn, calls };
}

describe('reading a database the editor has closed', () => {
  it('reads directly and copies nothing when the open succeeds', async () => {
    const db = await aDatabase();
    const { fn, calls } = fakeExecFile(new Set([db]));
    const rows = await defaultRunSqlite({
      sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', execFileFn: fn
    });
    assert.deepEqual(rows, ROWS);
    assert.equal(calls.length, 1, 'one attempt, no fallback');
    assert.equal(calls[0].dbPath, db, 'and it read the real file');
  });

  it('falls back to a copy when the direct open fails', async () => {
    const db = await aDatabase();
    // Only a path that is not the original will open: exactly the measured behaviour.
    const openable = new Set();
    const calls = [];
    const fn = async (bin, args) => {
      const dbPath = args[args.length - 2];
      calls.push(dbPath);
      if (dbPath === db) throw cantOpen();
      openable.add(dbPath);
      return { stdout: JSON.stringify(ROWS) };
    };
    const rows = await defaultRunSqlite({
      sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', execFileFn: fn
    });
    assert.deepEqual(rows, ROWS);
    assert.equal(calls.length, 2, 'the original, then the copy');
    assert.notEqual(calls[1], db);
    assert.ok(openable.size === 1);
  });

  it('opens the live file read-only and the copy unflagged', async () => {
    // Two measurements decided this and neither was the obvious answer. Retrying
    // `-readonly` on the copy fails exactly like the original, because what `-readonly`
    // wants is the `-shm` sidecar and a bare copy has none; the first version of this
    // fix did that and the real-CLI test below caught it. And the live file must never
    // be opened writable, because it belongs to another application.
    const db = await aDatabase();
    const seen = [];
    const fn = async (bin, args) => {
      const target = args[args.length - 2];
      seen.push({ target, readonly: args.includes('-readonly') });
      if (target === db) throw cantOpen();
      return { stdout: JSON.stringify(ROWS) };
    };
    await defaultRunSqlite({
      sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', execFileFn: fn
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].target, db);
    assert.equal(seen[0].readonly, true, 'another application\'s file is never opened writable');
    assert.notEqual(seen[1].target, db);
    assert.equal(seen[1].readonly, false, 'the snapshot must be openable enough to replay its WAL');
  });

  it('brings the journal sidecars along with the snapshot', async () => {
    // These databases are in WAL mode and the live file really does carry a -wal.
    // Copying only the main file drops whatever has not been checkpointed, which is
    // exactly the most recent activity a scan is looking for.
    const db = await aDatabase('main');
    await fsp.writeFile(`${db}-wal`, 'wal-contents');
    let sidecar = null;
    const fn = async (bin, args) => {
      const target = args[args.length - 2];
      if (target === db) throw cantOpen();
      sidecar = await fsp.readFile(`${target}-wal`, 'utf8').catch(() => null);
      return { stdout: JSON.stringify(ROWS) };
    };
    await defaultRunSqlite({
      sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', execFileFn: fn
    });
    assert.equal(sidecar, 'wal-contents');
  });

  it('does not mind when there are no sidecars to copy', async () => {
    // The ordinary case: a clean shutdown checkpoints and removes them.
    const db = await aDatabase();
    const fn = async (bin, args) => {
      const target = args[args.length - 2];
      if (target === db) throw cantOpen();
      return { stdout: JSON.stringify(ROWS) };
    };
    assert.deepEqual(await defaultRunSqlite({
      sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', execFileFn: fn
    }), ROWS);
  });

  it('copies the real bytes, not an empty file', async () => {
    const db = await aDatabase('SQLite format 3\0the actual contents');
    let copySeen = null;
    const fn = async (bin, args) => {
      const dbPath = args[args.length - 2];
      if (dbPath === db) throw cantOpen();
      copySeen = await fsp.readFile(asPath(dbPath), 'utf8');
      return { stdout: JSON.stringify(ROWS) };
    };
    await defaultRunSqlite({
      sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', execFileFn: fn
    });
    assert.equal(copySeen, 'SQLite format 3\0the actual contents');
  });

  it('never writes beside the original', async () => {
    const db = await aDatabase();
    const dir = nodePath.dirname(db);
    const before = (await fsp.readdir(dir)).sort();
    const fn = async (bin, args) => {
      const dbPath = args[args.length - 2];
      if (dbPath === db) throw cantOpen();
      assert.notEqual(nodePath.dirname(asPath(dbPath)), dir,
        'the copy must not land in the application\'s own directory');
      return { stdout: JSON.stringify(ROWS) };
    };
    await defaultRunSqlite({
      sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', execFileFn: fn
    });
    assert.deepEqual((await fsp.readdir(dir)).sort(), before);
  });

  it('deletes the copy after a successful read', async () => {
    const db = await aDatabase();
    let copyPath = null;
    const fn = async (bin, args) => {
      const dbPath = args[args.length - 2];
      if (dbPath === db) throw cantOpen();
      copyPath = asPath(dbPath);
      return { stdout: JSON.stringify(ROWS) };
    };
    await defaultRunSqlite({
      sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', execFileFn: fn
    });
    assert.ok(copyPath);
    await assert.rejects(fsp.access(copyPath), 'the copy must not survive the scan');
  });

  it('deletes the copy when the retry also fails', async () => {
    // A collector that leaks a multi-megabyte copy on every scan is worse than the
    // silence it was written to fix.
    const db = await aDatabase();
    let copyPath = null;
    const fn = async (bin, args) => {
      const dbPath = args[args.length - 2];
      if (dbPath !== db) copyPath = asPath(dbPath);
      throw cantOpen();
    };
    await assert.rejects(defaultRunSqlite({
      sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', execFileFn: fn
    }));
    assert.ok(copyPath, 'the fallback must have been attempted');
    await assert.rejects(fsp.access(copyPath));
  });
});

describe('what is not retried', () => {
  it('raises a missing sqlite3 CLI unchanged, with no copy', async () => {
    // v1.26.69 turns this into `sqlite_missing`, which on Windows is a one-command fix.
    const db = await aDatabase();
    const calls = [];
    const fn = async (bin, args) => { calls.push(args); throw cliMissing(); };
    await assert.rejects(
      defaultRunSqlite({ sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', execFileFn: fn }),
      (err) => err.code === 'ENOENT'
    );
    assert.equal(calls.length, 1, 'no second attempt');
  });

  it('raises any other sqlite failure unchanged', async () => {
    const db = await aDatabase();
    const calls = [];
    const fn = async (bin, args) => {
      calls.push(args);
      const err = new Error('Error: database disk image is malformed');
      err.code = 1;
      err.stderr = 'Error: database disk image is malformed\n';
      throw err;
    };
    await assert.rejects(
      defaultRunSqlite({ sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', execFileFn: fn }),
      /malformed/
    );
    assert.equal(calls.length, 1, 'no second attempt');
  });

  it('does not mistake a path that contains the phrase for a locked database', async () => {
    // `err.message` from execFile starts with the whole command line, path included, so
    // matching on it alone lets a directory name decide the classification.
    const dir = nodePath.join(ROOT, 'unable to open database file');
    await fsp.mkdir(dir, { recursive: true });
    const db = nodePath.join(dir, 'state.vscdb');
    await fsp.writeFile(db, 'x');
    const calls = [];
    const fn = async (bin, args) => {
      calls.push(args);
      const err = new Error(`Command failed: sqlite3 -json -readonly ${db} SELECT 1\n`
        + 'Error: database disk image is malformed\n');
      err.code = 1;
      err.stderr = 'Error: database disk image is malformed\n';
      throw err;
    };
    await assert.rejects(
      defaultRunSqlite({ sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', execFileFn: fn }),
      /malformed/
    );
    assert.equal(calls.length, 1, 'the path must not have triggered the fallback');
  });

  it('surfaces a real fallback failure rather than repeating the original', async () => {
    // A full disk or a permission wall on the temp directory is its own failure and
    // says more than a second "cannot open" would. It still classifies as `unreadable`.
    const db = await aDatabase();
    const fn = async (bin, args) => {
      const target = args[args.length - 2];
      if (target === db) throw cantOpen();
      const err = new Error('Error: database disk image is malformed');
      err.code = 1;
      err.stderr = 'Error: database disk image is malformed\n';
      throw err;
    };
    await assert.rejects(
      defaultRunSqlite({ sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', execFileFn: fn }),
      /malformed/
    );
  });

  it('raises the original error when the file is not there to copy', async () => {
    // The caller classifies the original. v1.26.69's adapter asks `exists` and turns
    // this into `no_install`; an error from the fallback instead would turn "you do not
    // have this tool" into "your tool is broken".
    const missing = nodePath.join(ROOT, 'does-not-exist.vscdb');
    const fn = async () => { throw cantOpen(); };
    await assert.rejects(
      defaultRunSqlite({ sqlitePath: 'sqlite3', dbPath: missing, sql: 'SELECT 1', execFileFn: fn }),
      /unable to open database file/
    );
  });
});

describe('the real sqlite3 CLI, on this machine', () => {
  it('reads a database with no sidecar beside it', async (t) => {
    // The regression this change exists for, run against the actual CLI rather than a
    // stand-in. Skipped where sqlite3 is not installed.
    const src = nodePath.join(nodeOs.homedir(),
      'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
    try {
      await fsp.access(src);
    } catch {
      t.skip('no Cursor database on this machine');
      return;
    }
    const isolated = await tempDir('ownmind-real-');
    const copy = nodePath.join(isolated, 'state.vscdb');
    // Deliberately without sidecars: this is the state the scheduled scan finds when
    // the editor is closed, and the exact case that used to come back empty.
    await fsp.copyFile(src, copy);
    // Count the real invocations, so a machine where the direct read happens to work
    // cannot pass this vacuously without ever entering the fallback.
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const realExec = promisify(execFile);
    const attempts = [];
    try {
      const rows = await defaultRunSqlite({
        sqlitePath: 'sqlite3',
        dbPath: copy,
        sql: "SELECT key, value FROM ItemTable WHERE key = 'telemetry.currentSessionDate'",
        execFileFn: (bin, args, opts) => { attempts.push(args); return realExec(bin, args, opts); }
      });
      assert.ok(Array.isArray(rows));
      assert.equal(rows.length, 1, 'the telemetry key must come back');
      if (attempts.length === 1) {
        t.skip('this machine reads a sidecar-less copy directly; fallback not exercised');
        return;
      }
      assert.equal(attempts.length, 2, 'the direct read failed and the fallback ran');
      assert.ok(attempts[0].includes('-readonly'));
      assert.ok(!attempts[1].includes('-readonly'), 'the snapshot is opened unflagged');
    } catch (err) {
      if (err.code === 'ENOENT') { t.skip('sqlite3 CLI not installed'); return; }
      throw err;
    } finally {
      await fsp.rm(isolated, { recursive: true, force: true });
    }
  });
});
