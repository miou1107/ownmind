// v1.26.71 — OpenCode could only be read while OpenCode was running.
//
// v1.26.70 fixed this for the Tier 2 adapters and recorded, out of scope, that
// shared/scanners/opencode.js carried its own copy of the same `sqlite3 -readonly`
// pattern. It does, and OpenCode is Tier 1: what goes missing is the per-message
// token_events every other number is derived from, with no second source to infer it
// back from.
//
// Measured on a Mac on 2026-08-06, the same controlled test as v1.26.70:
//
//   sqlite3 -json -readonly "<copy in an empty directory>"  -> unable to open (14)
//   sqlite3 -json          "<the same copy>"                -> [{"count(*)":1205}]
//
// PRAGMA journal_mode on the live file returns `wal`, so it is the same shape and the
// same failure. The first measurement of this was contaminated: `-readonly` appeared to
// work against the live file only because the PRAGMA probe one line earlier had opened
// it read-write and created the -shm sidecar that -readonly needs.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import nodePath from 'path';
import nodeOs from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tempDir } from './helpers/temp-dir.js';

const execFileP = promisify(execFile);

const { createOpenCodeAdapter, defaultRunSqlite } =
  await import('../shared/scanners/opencode.js');
const { runSqliteCli } = await import('../shared/scanners/sqlite-cli.js');
const { deriveReason } = await import('../shared/scanners/base.js');
const vscodeTelemetry = await import('../shared/scanners/vscode-telemetry.js');

const ROWS = [{ id: 'msg_a', session_id: 's1', time_created: 1, data: '{}' }];

/** The shape execFile rejects with when the sqlite3 CLI exits non-zero. */
function cantOpen() {
  const err = new Error('Command failed: sqlite3 ...\n'
    + 'Error: in prepare, unable to open database file (14)\n');
  err.code = 1;
  err.stderr = 'Error: in prepare, unable to open database file (14)\n';
  return err;
}

let ROOT;
before(async () => {
  ROOT = await tempDir('ownmind-oc-closed-');
});
after(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
});

let seq = 0;
async function aDatabase(contents = 'SQLite format 3\0fake') {
  const p = nodePath.join(ROOT, `db-${seq += 1}.db`);
  await fsp.writeFile(p, contents);
  return p;
}

// ────────────────────────────────────────────────────────────
// Requirement 1 — one implementation, used by both
// ────────────────────────────────────────────────────────────

describe('one implementation of the fallback', () => {
  it('is the function the Tier 2 adapters already call', () => {
    // Not "behaves the same as": the same object. Two copies of this pattern existed
    // and only one of them got fixed, which is the whole reason for this change.
    assert.equal(vscodeTelemetry.defaultRunSqlite, runSqliteCli);
  });

  it('defaults the output ceiling to 10 MB', async () => {
    const db = await aDatabase();
    let opts = null;
    await runSqliteCli({
      sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1',
      execFileFn: async (bin, args, o) => { opts = o; return { stdout: '[]' }; }
    });
    assert.equal(opts.maxBuffer, 10 * 1024 * 1024);
  });

  it('lets a caller raise the ceiling', async () => {
    const db = await aDatabase();
    let opts = null;
    await runSqliteCli({
      sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', maxBuffer: 42,
      execFileFn: async (bin, args, o) => { opts = o; return { stdout: '[]' }; }
    });
    assert.equal(opts.maxBuffer, 42);
  });

  it('keeps the raised ceiling on the snapshot attempt too', async () => {
    // A first scan of a long history is exactly the case that both needs the fallback
    // and overflows a 10 MB buffer. Raising it only on the direct read would swap one
    // silent failure for another.
    const db = await aDatabase();
    const seen = [];
    await runSqliteCli({
      sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', maxBuffer: 42,
      execFileFn: async (bin, args, o) => {
        seen.push(o.maxBuffer);
        if (args[args.length - 2] === db) throw cantOpen();
        return { stdout: '[]' };
      }
    });
    assert.deepEqual(seen, [42, 42]);
  });
});

// ────────────────────────────────────────────────────────────
// Requirement 2 — OpenCode reads a closed database
// ────────────────────────────────────────────────────────────

describe('OpenCode reading a database its application has closed', () => {
  it('asks for the 100 MB ceiling a Tier 1 scan needs', async () => {
    // Tier 2 reads three telemetry rows. This reads every assistant message since the
    // cursor, which on a first scan is the entire history.
    const db = await aDatabase();
    let opts = null;
    await defaultRunSqlite({
      sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1',
      execFileFn: async (bin, args, o) => { opts = o; return { stdout: '[]' }; }
    });
    assert.equal(opts.maxBuffer, 100 * 1024 * 1024);
  });

  it('keeps that ceiling when a caller passes maxBuffer undefined', async () => {
    // Spreading opts over a default would put that undefined through and land on the
    // shared 10 MB, which is the one value this ceiling exists to avoid.
    const db = await aDatabase();
    let opts = null;
    await defaultRunSqlite({
      sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', maxBuffer: undefined,
      execFileFn: async (bin, args, o) => { opts = o; return { stdout: '[]' }; }
    });
    assert.equal(opts.maxBuffer, 100 * 1024 * 1024);
  });

  it('still lets a caller name a different ceiling on purpose', async () => {
    const db = await aDatabase();
    let opts = null;
    await defaultRunSqlite({
      sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1', maxBuffer: 7,
      execFileFn: async (bin, args, o) => { opts = o; return { stdout: '[]' }; }
    });
    assert.equal(opts.maxBuffer, 7);
  });

  it('falls back to a snapshot when the direct open fails', async () => {
    const db = await aDatabase();
    const targets = [];
    const rows = await defaultRunSqlite({
      sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1',
      execFileFn: async (bin, args) => {
        const target = args[args.length - 2];
        targets.push({ target, readonly: args.includes('-readonly') });
        if (target === db) throw cantOpen();
        return { stdout: JSON.stringify(ROWS) };
      }
    });
    assert.deepEqual(rows, ROWS);
    assert.equal(targets.length, 2, 'the original, then the snapshot');
    assert.equal(targets[0].readonly, true, 'the live file is never opened writable');
    assert.equal(targets[1].readonly, false, 'the snapshot must be able to replay its WAL');
    assert.notEqual(targets[1].target, db);
  });

  it('raises a missing sqlite3 CLI unchanged so the adapter can name it', async () => {
    // The adapter's own message names OpenCode and the per-platform install command.
    // Routing ENOENT through the fallback would replace a one-command fix with a
    // generic failure.
    const db = await aDatabase();
    const calls = [];
    const enoent = new Error('spawn sqlite3 ENOENT');
    enoent.code = 'ENOENT';
    await assert.rejects(
      defaultRunSqlite({
        sqlitePath: 'sqlite3', dbPath: db, sql: 'SELECT 1',
        execFileFn: async (bin, args) => { calls.push(args); throw enoent; }
      }),
      (err) => err.code === 'ENOENT'
    );
    assert.equal(calls.length, 1, 'no snapshot attempted');
  });

  it('hands the adapter logger to the runner', async () => {
    // The fallback's diagnostics are the only thing separating "the database is locked"
    // from "the temporary directory is full". Without a logger they go nowhere.
    let received;
    const logger = { warn() {} };
    const adapter = createOpenCodeAdapter({
      dbPath: '/nowhere/opencode.db',
      logger,
      runSqlite: async (opts) => { received = opts; return []; }
    });
    await adapter.readSince({});
    assert.equal(received.logger, logger);
  });
});

// ────────────────────────────────────────────────────────────
// Requirement 3 — the collector says why OpenCode is quiet
// ────────────────────────────────────────────────────────────

describe('why OpenCode sent nothing', () => {
  const failing = (err) => async () => { throw err; };

  it('says unreadable when the database is there and will not open', async () => {
    // Without this the orchestrator's deriveReason sees no events, no sessions, no
    // scanned count and no skipped list, and answers `no_new_activity` — "he just did
    // not use it today". That is the false-healthy signal v1.26.69 was written to kill,
    // and OpenCode never got it.
    const db = await aDatabase();
    const adapter = createOpenCodeAdapter({ dbPath: db, runSqlite: failing(cantOpen()) });
    const out = await adapter.readSince({});
    assert.equal(out.reason, 'unreadable');
    // The heartbeat is stamped by the orchestrator, which prefers the adapter's reason
    // over its own derivation; the next test is what makes that difference visible.
  });

  it('is the only thing standing between that and a false all-clear', () => {
    // What the orchestrator would answer on its own for this adapter's failure shape:
    // no events, no sessions, no file count, no skipped list. `no_new_activity` reads as
    // "he simply did not use OpenCode today" and is indistinguishable from health.
    assert.equal(deriveReason({ events: [], sessions: [] }), 'no_new_activity');
  });

  it('says no_install when there is no database at all', async () => {
    // `sqlite3 -readonly` answers "unable to open database file" for a path with nothing
    // at it, which arrives here as a failure rather than an absence. Reporting that as
    // `unreadable` turns "you do not run OpenCode" into "your OpenCode is broken".
    const gone = nodePath.join(ROOT, 'not-installed', 'opencode.db');
    const adapter = createOpenCodeAdapter({ dbPath: gone, runSqlite: failing(cantOpen()) });
    const out = await adapter.readSince({});
    assert.equal(out.reason, 'no_install');
  });

  it('says sqlite_missing when the CLI is not installed', async () => {
    const db = await aDatabase();
    const enoent = new Error('spawn sqlite3 ENOENT');
    enoent.code = 'ENOENT';
    const adapter = createOpenCodeAdapter({ dbPath: db, runSqlite: failing(enoent) });
    const out = await adapter.readSince({});
    assert.equal(out.reason, 'sqlite_missing');
  });

  it('leaves a healthy scan to the orchestrator', async () => {
    // A successful read must not carry a hardcoded reason: `ok` versus `no_new_activity`
    // is derived from whether anything came back, in one place, for every adapter.
    const adapter = createOpenCodeAdapter({ dbPath: '/x', runSqlite: async () => [] });
    const out = await adapter.readSince({});
    assert.equal(out.reason, undefined);
  });
});

// ────────────────────────────────────────────────────────────
// Requirement 4 — a short read costs a delay, never data
// ────────────────────────────────────────────────────────────

describe('a snapshot that yields only part of the history', () => {
  it('advances the cursor only as far as the rows it converted', async () => {
    const assistant = (id, ms) => ({
      id, session_id: 's1', time_created: ms,
      data: JSON.stringify({
        role: 'assistant', time: { created: ms }, modelID: 'm',
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
      })
    });
    const adapter = createOpenCodeAdapter({
      dbPath: '/x',
      runSqlite: async () => [assistant('msg_a', 1000), assistant('msg_b', 2000)]
    });
    const out = await adapter.readSince({});
    assert.equal(out.events.length, 2);
    assert.equal(out.offsetPatch.opencode.high_water_time, 2000);
    assert.equal(out.offsetPatch.opencode.high_water_id, 'msg_b');
    // The next scan starts from msg_b, so anything a truncated snapshot left behind is
    // still ahead of the cursor rather than skipped.
  });
});

// ────────────────────────────────────────────────────────────
// The real CLI, end to end through the adapter
// ────────────────────────────────────────────────────────────

describe('the real sqlite3 CLI, on this machine', () => {
  it('carries the adapter logger through the wiring nobody injected', async (t) => {
    // Every other test here replaces `runSqlite`, so none of them touches the default
    // the adapter actually uses in production. This one drives the whole chain — adapter
    // to defaultRunSqlite to runSqliteCli to the snapshot fallback — with a real CLI and
    // a real logger, against a path with nothing at it.
    const warnings = [];
    const adapter = createOpenCodeAdapter({
      dbPath: nodePath.join(ROOT, 'absent', 'opencode.db'),
      logger: { warn: (m) => warnings.push(m) }
    });
    const out = await adapter.readSince({});
    if (warnings.some((w) => /sqlite3 CLI not found/.test(w))) {
      t.skip('sqlite3 CLI not installed');
      return;
    }
    assert.equal(out.reason, 'no_install');
    assert.ok(
      warnings.some((w) => w.startsWith('[sqlite-cli]')),
      `the fallback's own diagnostics must reach the adapter logger; got ${JSON.stringify(warnings)}`
    );
  });

  it('reads an OpenCode database with no sidecar beside it', async (t) => {
    const dir = nodePath.join(ROOT, 'real');
    await fsp.mkdir(dir, { recursive: true });
    const db = nodePath.join(dir, 'opencode.db');
    const created = 1772435795982;
    const data = JSON.stringify({
      role: 'assistant', time: { created }, modelID: 'big-pickle', cost: 0.5,
      tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }
    }).replace(/'/g, "''");

    try {
      // WAL, then a clean close, which checkpoints and removes both sidecars. That is
      // the state a scheduled scan finds when OpenCode is not running.
      await execFileP('sqlite3', [db,
        'PRAGMA journal_mode=WAL;'
        + 'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT,'
        + ' time_created INTEGER, data TEXT);'
        + `INSERT INTO message VALUES ('msg_real','sess_real',${created},'${data}');`
      ]);
    } catch (err) {
      if (err.code === 'ENOENT') { t.skip('sqlite3 CLI not installed'); return; }
      throw err;
    }

    for (const suffix of ['-wal', '-shm']) {
      await fsp.rm(`${db}${suffix}`, { force: true });
    }

    // The premise of this test, asserted rather than assumed: without a sidecar the
    // direct read really does fail. If a future sqlite3 stops failing here, this test
    // would otherwise keep passing while proving nothing.
    let directFailed = false;
    try {
      await execFileP('sqlite3', ['-json', '-readonly', db, 'SELECT count(*) FROM message;']);
    } catch {
      directFailed = true;
    }
    if (!directFailed) {
      t.skip('this sqlite3 opens a sidecar-less WAL database read-only; nothing to fall back from');
      return;
    }

    const attempts = [];
    const adapter = createOpenCodeAdapter({
      dbPath: db,
      runSqlite: (opts) => runSqliteCli({
        ...opts,
        execFileFn: (bin, args, o) => { attempts.push(args); return execFileP(bin, args, o); }
      })
    });
    const out = await adapter.readSince({});

    assert.equal(attempts.length, 2, 'the direct read failed and the fallback ran');
    assert.equal(out.events.length, 1, 'the message came back');
    assert.equal(out.events[0].message_id, 'msg_real');
    assert.equal(out.events[0].input_tokens, 10);
    assert.equal(out.events[0].output_tokens, 20);
  });
});
