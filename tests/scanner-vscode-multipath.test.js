// v1.26.66 — Antigravity renamed its storage directory and the adapter kept reading
// the old one.
//
// Measured on Vin's Mac, 2026-08-05. Two applications are installed:
// com.google.antigravity (2.5.0) writing ~/Library/Application Support/Antigravity,
// and com.google.antigravity-ide (2.1.1) writing ".../Antigravity IDE". The first
// directory's telemetry stops on 2026-05-18; the second's starts 2026-05-20 and runs
// to today. One stops on the day the other starts, which is a migration.
//
// The shipped adapter, run unchanged against each path:
//
//     Antigravity      -> [{"date":"2026-05-18"}]
//     Antigravity IDE  -> [{"date":"2026-08-05"}]
//
// Eleven weeks of one tool's usage was never recorded, on a machine that checked in
// every two hours throughout. Tier 2 emits no token events by construction, so the
// only symptom available was "no new day", which is also what every ordinary scan
// produces.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import nodePath from 'path';
import nodeOs from 'os';

const { createVscodeAdapter, defaultExists, toTaipeiYmd } =
  await import('../shared/scanners/vscode-telemetry.js');
const { createAntigravityAdapter, antigravityDbCandidates } =
  await import('../shared/scanners/antigravity.js');
const { createCursorAdapter } = await import('../shared/scanners/cursor.js');

const OLD = '/home/u/Antigravity/state.vscdb';
const NEW = '/home/u/Antigravity IDE/state.vscdb';

const current = (v) => ({ key: 'telemetry.currentSessionDate', value: v });
const last = (v) => ({ key: 'telemetry.lastSessionDate', value: v });

/**
 * sqlite mock keyed by database path, plus the list of paths it was actually asked
 * for. A path absent from `byPath` is treated as a file that exists but errors, which
 * is deliberately different from a file that is not there at all.
 */
function fakeSqlite(byPath) {
  const queried = [];
  const run = async ({ dbPath }) => {
    queried.push(dbPath);
    if (!(dbPath in byPath)) {
      const err = new Error(`unable to open database file: ${dbPath}`);
      throw err;
    }
    return byPath[dbPath];
  };
  return { run, queried };
}

const existsOnly = (...present) => async (p) => present.includes(p);

describe('a renamed install directory must not freeze the collector', () => {
  it('reads the directory the application actually writes to', async () => {
    const { run } = fakeSqlite({
      [OLD]: [current('Mon, 18 May 2026 04:09:19 GMT')],
      [NEW]: [current('Tue, 04 Aug 2026 01:11:28 GMT')],
    });
    const adapter = createVscodeAdapter({
      tool: 'antigravity',
      dbPaths: [OLD, NEW],
      runSqlite: run,
      exists: existsOnly(OLD, NEW),
    });

    const r = await adapter.readSince({});
    assert.equal(r.sessions.length, 1);
    assert.equal(r.sessions[0].date, '2026-08-04',
      'reading only the first candidate is what cost eleven weeks of data');
  });

  it('does not let list order decide which install wins', async () => {
    // Same two databases, candidate list reversed. If the answer changes, the code is
    // picking by position rather than by date, and the next rename breaks it again.
    const { run } = fakeSqlite({
      [OLD]: [current('Mon, 18 May 2026 04:09:19 GMT')],
      [NEW]: [current('Tue, 04 Aug 2026 01:11:28 GMT')],
    });
    const adapter = createVscodeAdapter({
      tool: 'antigravity',
      dbPaths: [NEW, OLD],
      runSqlite: run,
      exists: existsOnly(OLD, NEW),
    });

    assert.equal((await adapter.readSince({})).sessions[0].date, '2026-08-04');
  });

  it('applies the lastSessionDate fallback per candidate, before comparing', async () => {
    // A candidate holding only lastSessionDate must still be able to win. Comparing
    // currentSessionDate first across all candidates and only then falling back would
    // pick the older install here.
    const { run } = fakeSqlite({
      [OLD]: [last('Sat, 01 Aug 2026 10:00:00 GMT')],
      [NEW]: [current('Wed, 01 Jul 2026 10:00:00 GMT')],
    });
    const adapter = createVscodeAdapter({
      tool: 'antigravity',
      dbPaths: [OLD, NEW],
      runSqlite: run,
      exists: existsOnly(OLD, NEW),
    });

    assert.equal((await adapter.readSince({})).sessions[0].date, '2026-08-01');
  });

  it('an empty database does not suppress a usable one', async () => {
    const { run } = fakeSqlite({
      [OLD]: [],
      [NEW]: [current('Tue, 04 Aug 2026 01:11:28 GMT')],
    });
    const adapter = createVscodeAdapter({
      tool: 'antigravity',
      dbPaths: [OLD, NEW],
      runSqlite: run,
      exists: existsOnly(OLD, NEW),
    });

    assert.equal((await adapter.readSince({})).sessions[0].date, '2026-08-04');
  });
});

describe('a directory that was never installed is not a failure', () => {
  it('never queries a database file that is not there', async () => {
    // Every single-install machine runs this every two hours. Querying the absent
    // candidate would work, but it would also log "sqlite query failed" forever, and
    // a warning that fires on healthy machines stops being read.
    const logs = [];
    const { run, queried } = fakeSqlite({
      [OLD]: [current('Mon, 18 May 2026 04:09:19 GMT')],
    });
    const adapter = createVscodeAdapter({
      tool: 'antigravity',
      dbPaths: [OLD, NEW],
      runSqlite: run,
      exists: existsOnly(OLD),
      logger: { warn: (m) => logs.push(m) },
    });

    const r = await adapter.readSince({});
    assert.deepEqual(queried, [OLD], 'the absent candidate must not be queried');
    assert.deepEqual(logs, [], 'and must not produce a warning');
    assert.equal(r.sessions[0].date, '2026-05-18');
  });

  it('emits no session but still checks in when nothing is installed', async () => {
    const { run, queried } = fakeSqlite({});
    const adapter = createVscodeAdapter({
      tool: 'antigravity',
      dbPaths: [OLD, NEW],
      runSqlite: run,
      exists: existsOnly(),
    });

    const r = await adapter.readSince({});
    assert.deepEqual(queried, []);
    assert.deepEqual(r.sessions, []);
    assert.equal(r.heartbeat.tool, 'antigravity',
      'a tool with nothing to report must still be visibly alive');
  });

  it('a present but unreadable database still warns, and the rest are still read', async () => {
    // Present-and-broken is not the same as never-installed. Collapsing the two is the
    // defect this release and v1.26.65 are both about.
    const logs = [];
    const { run } = fakeSqlite({
      [NEW]: [current('Tue, 04 Aug 2026 01:11:28 GMT')],
    });
    const adapter = createVscodeAdapter({
      tool: 'antigravity',
      dbPaths: [OLD, NEW],
      runSqlite: run,
      exists: existsOnly(OLD, NEW),
      logger: { warn: (m) => logs.push(m) },
    });

    const r = await adapter.readSince({});
    assert.equal(logs.length, 1);
    assert.match(logs[0], /unable to open database file/);
    assert.equal(r.sessions[0].date, '2026-08-04', 'the readable candidate still wins');
  });
});

describe('"not installed" must mean absent, never "I could not tell"', () => {
  // Review finding, 2026-08-05: filtering candidates by existence re-introduced the
  // exact defect this release exists to remove. `catch { return false }` turns a
  // permission wall into "not installed", and the candidate is dropped before sqlite
  // is ever invoked — so the warning the single-path code used to produce disappears.
  // Only ENOENT means absent. Everything else goes through to the query, where it is
  // logged.
  const TMP = nodePath.join(nodeOs.tmpdir(), `ownmind-exists-${process.pid}`);
  after(async () => {
    try { await fsp.chmod(nodePath.join(TMP, 'walled'), 0o755); } catch { /* may not exist */ }
    try { await fsp.rm(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a file that is there reads as present', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    const f = nodePath.join(TMP, 'state.vscdb');
    await fsp.writeFile(f, '');
    assert.equal(await defaultExists(f), true);
  });

  it('a file that is not there reads as absent', async () => {
    assert.equal(await defaultExists(nodePath.join(TMP, 'never-existed.vscdb')), false);
  });

  it('a path that cannot exist is not reported as absent', async () => {
    // A regular file where a directory belongs gives ENOTDIR on every platform,
    // including Windows. It is also the shape of a wrongly resolved home directory,
    // which is one of the things v1.26.65 was about, so it must be loud rather than
    // silently treated as a clean machine.
    await fsp.mkdir(TMP, { recursive: true });
    const notADir = nodePath.join(TMP, 'a-file');
    await fsp.writeFile(notADir, 'x');
    assert.equal(await defaultExists(nodePath.join(notADir, 'state.vscdb')), true);
  });

  it('a permission wall is not reported as absent', async (t) => {
    await fsp.mkdir(nodePath.join(TMP, 'walled'), { recursive: true });
    const target = nodePath.join(TMP, 'walled', 'state.vscdb');
    await fsp.writeFile(target, '');
    await fsp.chmod(nodePath.join(TMP, 'walled'), 0o000);

    let walled = true;
    try { await fsp.access(target); walled = false; } catch { /* expected */ }
    if (!walled) {
      t.skip('chmod does not block access here (root, or Windows); see the ENOTDIR case');
      return;
    }
    assert.equal(await defaultExists(target), true);
  });
});

describe('a stale install must not be able to poison the live one', () => {
  // Review finding, 2026-08-05: picking the maximum date blindly means one abandoned
  // database holding a future timestamp — a rolled-forward system clock, a bad VM
  // clock — wins every comparison forever. It is emitted once, the cursor advances to
  // it, and from then on the live install's real dates are silently suppressed. That
  // is strictly worse than the bug being fixed, because it converts one dead directory
  // into a dead tool.
  const day = 86400 * 1000;
  const at = (offsetMs) => new Date(Date.now() + offsetMs).toUTCString();

  it('ignores a candidate dated far in the future', async () => {
    const logs = [];
    const { run } = fakeSqlite({
      [OLD]: [current(at(400 * day))],
      [NEW]: [current(at(-2 * day))],
    });
    const adapter = createVscodeAdapter({
      tool: 'antigravity',
      dbPaths: [OLD, NEW],
      runSqlite: run,
      exists: existsOnly(OLD, NEW),
      logger: { warn: (m) => logs.push(m) },
    });

    const r = await adapter.readSince({});
    assert.equal(r.sessions[0].date, toTaipeiYmd(new Date(Date.now() - 2 * day)),
      'the live install must win over a future-dated abandoned one');
    assert.equal(logs.length, 1, 'and discarding a date must not be silent');
    assert.match(logs[0], /future/i);
  });

  it('keeps a date only slightly ahead, because clocks jitter', async () => {
    // Rejecting anything at all ahead of now would drop legitimate sessions over
    // timezone boundaries and ordinary clock drift. The guard is for absurd values,
    // not for seconds.
    const logs = [];
    const { run } = fakeSqlite({ [NEW]: [current(at(2 * 3600 * 1000))] });
    const adapter = createVscodeAdapter({
      tool: 'antigravity',
      dbPaths: [NEW],
      runSqlite: run,
      exists: existsOnly(NEW),
      logger: { warn: (m) => logs.push(m) },
    });

    const r = await adapter.readSince({});
    assert.equal(r.sessions.length, 1);
    assert.deepEqual(logs, []);
  });

  it('emits nothing rather than a future date when that is all there is', async () => {
    const { run } = fakeSqlite({ [OLD]: [current(at(400 * day))] });
    const adapter = createVscodeAdapter({
      tool: 'antigravity',
      dbPaths: [OLD],
      runSqlite: run,
      exists: existsOnly(OLD),
    });

    const r = await adapter.readSince({});
    assert.deepEqual(r.sessions, [], 'a date that has not happened is not a session');
    assert.ok(r.heartbeat, 'and the tool is still visibly alive');
  });
});

describe('the day cursor stays self-healing', () => {
  it('re-emits when a candidate disappears and the date goes backwards', async () => {
    // Deliberate. When the fresher install is transiently unreadable the adapter falls
    // back to an older real date, which differs from the stored cursor, so it emits
    // again. The server upserts session_count with GREATEST(existing, new) on
    // (user_id, tool, date), so this costs one redundant write of a day that genuinely
    // happened and nothing else.
    //
    // The alternative — only emitting when the date advances — was rejected: a cursor
    // that ever gets ahead of reality would then suppress every real day beneath it,
    // permanently and silently. Given this release is entirely about permanent silent
    // loss, a redundant idempotent write is the correct side to err on.
    const { run } = fakeSqlite({ [OLD]: [current('Sat, 01 Aug 2026 10:00:00 GMT')] });
    const adapter = createVscodeAdapter({
      tool: 'antigravity',
      dbPaths: [OLD, NEW],
      runSqlite: run,
      exists: existsOnly(OLD),
    });

    const r = await adapter.readSince({ antigravity: { last_session_date: '2026-08-05' } });
    assert.equal(r.sessions.length, 1);
    assert.equal(r.sessions[0].date, '2026-08-01');
  });
});

describe('the scanner log must be readable for a Tier 2 tool', () => {
  // Found by running the real scanner end to end after the fix landed. The session row
  // reached production, and the line the scanner wrote about it was:
  //
  //     [scanner] antigravity sent=0 accepted=0 duplicated=0 batches=0
  //
  // `sent` counts token events, and Tier 2 has none by construction, so cursor and
  // antigravity print all zeros whether they recorded a day or recorded nothing. That
  // is the line a human reads to decide whether collection works, and for two of the
  // five tools it could not answer the question. `runScan` already returns the count.
  //
  // A source-level assertion rather than a behavioural one: exercising main() needs
  // real credentials and a real POST. The value it guards is that the count reaches
  // the log at all, which is visible in the template.
  it('prints the session count, not only the event count', async () => {
    const src = await fsp.readFile(
      new URL('../hooks/ownmind-usage-scanner.js', import.meta.url), 'utf8');
    assert.match(src, /sessions=\$\{result\.sessions/,
      'without this, a Tier 2 tool logs all zeros whether or not it collected anything');
  });
});

describe('antigravityDbCandidates', () => {
  const bothNames = (paths) => {
    assert.equal(paths.length, 2);
    assert.ok(paths.some((p) => /[/\\]Antigravity[/\\]/.test(p)), 'original name');
    assert.ok(paths.some((p) => /Antigravity IDE/.test(p)), 'renamed');
  };

  // path.join uses the separator of the host running the tests, not of the platform
  // being described, so every layout assertion has to accept both. A test that only
  // matches forward slashes passes on a Mac and silently asserts nothing on Windows.
  const APP_SUPPORT = /Library[/\\]Application Support[/\\]/;

  it('covers both names under Application Support on darwin', () => {
    const p = antigravityDbCandidates('darwin', '/Users/x');
    bothNames(p);
    assert.ok(p.every((x) => APP_SUPPORT.test(x)));
    assert.ok(p.every((x) => x.endsWith('state.vscdb')));
  });

  it('covers both names under AppData/Roaming on win32', () => {
    const p = antigravityDbCandidates('win32', 'C:\\Users\\x');
    bothNames(p);
    assert.ok(p.every((x) => /AppData[/\\]Roaming[/\\]/.test(x)));
  });

  it('covers both names under .config on linux', () => {
    const p = antigravityDbCandidates('linux', '/home/x');
    bothNames(p);
    assert.ok(p.every((x) => /[/\\]\.config[/\\]/.test(x)));
  });

  it('falls back to the darwin layout on an unknown platform', () => {
    // The previous code did exactly this with `?? DEFAULT_DB_PATHS.darwin`; keep it
    // rather than start returning nothing on an unrecognised platform.
    const p = antigravityDbCandidates('sunos', '/home/x');
    bothNames(p);
    assert.ok(p.every((x) => APP_SUPPORT.test(x)));
  });
});

describe('the existing injection contract is preserved', () => {
  it('an explicit dbPath reads exactly that one path', async () => {
    const { run, queried } = fakeSqlite({
      '/explicit/state.vscdb': [current('Tue, 21 Apr 2026 09:00:00 GMT')],
    });
    const adapter = createAntigravityAdapter({
      dbPath: '/explicit/state.vscdb',
      runSqlite: run,
      exists: existsOnly('/explicit/state.vscdb'),
    });

    const r = await adapter.readSince({});
    assert.deepEqual(queried, ['/explicit/state.vscdb']);
    assert.equal(r.sessions[0].date, '2026-04-21');
  });

  it('cursor still reads its single directory', async () => {
    const { run, queried } = fakeSqlite({
      '/c/state.vscdb': [current('Tue, 21 Apr 2026 09:00:00 GMT')],
    });
    const adapter = createCursorAdapter({
      dbPath: '/c/state.vscdb',
      runSqlite: run,
      exists: existsOnly('/c/state.vscdb'),
    });

    assert.equal(adapter.tool, 'cursor');
    const r = await adapter.readSince({});
    assert.deepEqual(queried, ['/c/state.vscdb']);
    assert.equal(r.sessions[0].date, '2026-04-21');
  });
});
