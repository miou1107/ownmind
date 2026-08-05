// v1.26.68 — Antigravity has three surfaces and only one of them is a VSCode
// application.
//
// Measured on Vin's Mac, 2026-08-05. Conversation stores under ~/.gemini, counted by
// file mtime:
//
//     ~/.gemini/antigravity/conversations       114 files, 10 days, newest 2026-08-05
//     ~/.gemini/antigravity-ide/conversations   108 files,  6 days, newest 2026-08-05
//     ~/.gemini/antigravity-cli/conversations  1489 files,  9 days, newest 2026-08-05
//
// The manager's own state.vscdb still reports currentSessionDate = 2026-05-18, so the
// eight days of manager conversations and nine days of CLI conversations after that
// date are invisible to a collector that reads only VSCode telemetry. v1.26.66 fixed
// which state.vscdb is read; it could not fix surfaces that never write one.
//
// Backlog item 18 had recorded that the manager writes nothing locally. That was
// measured under ~/Library/Application Support/Antigravity, where the Electron shell
// lives. The conversations are under ~/.gemini.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import nodePath from 'path';
import nodeOs from 'os';

const { createVscodeAdapter, toTaipeiYmd } =
  await import('../shared/scanners/vscode-telemetry.js');
const { createAntigravityAdapter } =
  await import('../shared/scanners/antigravity.js');
const { createCursorAdapter } = await import('../shared/scanners/cursor.js');
const { geminiConversationDirs, newestConversationMtime } =
  await import('../shared/scanners/gemini-conversations.js');

const current = (v) => ({ key: 'telemetry.currentSessionDate', value: v });

/** sqlite mock keyed by database path. */
function fakeSqlite(byPath) {
  const queried = [];
  const run = async ({ dbPath }) => {
    queried.push(dbPath);
    if (!(dbPath in byPath)) throw new Error(`unable to open database file: ${dbPath}`);
    return byPath[dbPath];
  };
  return { run, queried };
}

function collectingLogger() {
  const warnings = [];
  return { logger: { warn: (m) => warnings.push(m) }, warnings };
}

// ────────────────────────────────────────────────────────────
// Real temp directories. mtime behaviour is the thing under test, so faking the
// filesystem here would test the fake.
// ────────────────────────────────────────────────────────────

let ROOT;

before(async () => {
  ROOT = await fsp.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'ownmind-ag-conv-'));
});

after(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
});

let seq = 0;
/** A conversation directory holding the given files, each stamped to its ISO date. */
async function makeConvDir(files) {
  const dir = nodePath.join(ROOT, `conv-${seq += 1}`);
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, iso] of Object.entries(files)) {
    const p = nodePath.join(dir, name);
    await fsp.writeFile(p, 'x');
    const t = new Date(iso);
    await fsp.utimes(p, t, t);
  }
  return dir;
}

describe('every Antigravity surface has a conversation store', () => {
  it('lists the manager, the editor and the CLI', () => {
    const dirs = geminiConversationDirs('/home/u');
    assert.equal(dirs.length, 3);
    for (const surface of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
      assert.ok(
        dirs.some((d) => new RegExp(`\\.gemini[\\\\/]${surface}[\\\\/]conversations$`).test(d)),
        `expected a conversations directory for ${surface}, got ${JSON.stringify(dirs)}`
      );
    }
  });

  it('does not include the migration backup directory', () => {
    // ~/.gemini/antigravity-backup exists on the measured machine and holds 101
    // conversation files frozen at the 2026-05-20 migration. A glob would match it.
    const dirs = geminiConversationDirs('/home/u');
    assert.ok(dirs.length > 0, 'an empty list would pass this vacuously');
    assert.ok(!dirs.some((d) => d.includes('antigravity-backup')));
  });

  it('uses one home-relative layout on every platform', () => {
    // Unlike state.vscdb, ~/.gemini is not under an OS-specific application directory.
    const dirs = geminiConversationDirs('/home/u');
    assert.ok(dirs.length > 0, 'an empty list would pass this vacuously');
    for (const d of dirs) {
      assert.ok(/^[\\/]home[\\/]u[\\/]\.gemini[\\/]/.test(d), d);
      assert.ok(!/Application Support|AppData|\.config/.test(d), d);
    }
  });
});

describe('finding the newest conversation', () => {
  it('takes the freshest across surfaces', async () => {
    const a = await makeConvDir({ 'a.db': '2026-07-30T10:00:00Z' });
    const b = await makeConvDir({ 'b.db': '2026-08-05T14:37:00Z' });
    const got = await newestConversationMtime({ dirs: [a, b] });
    assert.equal(got.toISOString(), '2026-08-05T14:37:00.000Z');
  });

  it('is not affected by the order the directories are given in', async () => {
    const a = await makeConvDir({ 'a.db': '2026-07-30T10:00:00Z' });
    const b = await makeConvDir({ 'b.db': '2026-08-05T14:37:00Z' });
    const fwd = await newestConversationMtime({ dirs: [a, b] });
    const rev = await newestConversationMtime({ dirs: [b, a] });
    assert.equal(fwd.getTime(), rev.getTime());
  });

  it('considers every file format, not only .db', async () => {
    // Measured: the manager holds 13 .db and 100 .pb; the CLI's newest entry is a
    // .db-wal. The product has already changed conversation format once.
    const d = await makeConvDir({
      'old.db': '2026-01-01T00:00:00Z',
      'newest.pb': '2026-08-05T14:00:00Z'
    });
    const got = await newestConversationMtime({ dirs: [d] });
    assert.equal(got.toISOString(), '2026-08-05T14:00:00.000Z');
  });

  it('ignores subdirectories', async () => {
    const d = await makeConvDir({ 'a.db': '2026-07-30T10:00:00Z' });
    const sub = nodePath.join(d, 'nested');
    await fsp.mkdir(sub);
    const t = new Date('2026-09-01T00:00:00Z');
    await fsp.utimes(sub, t, t);
    const got = await newestConversationMtime({ dirs: [d] });
    assert.equal(got.toISOString(), '2026-07-30T10:00:00.000Z');
  });

  it('passes over an installed surface that has no conversations yet', async () => {
    const empty = await makeConvDir({});
    const used = await makeConvDir({ 'c.db': '2026-08-05T14:00:00Z' });
    const { logger, warnings } = collectingLogger();
    const got = await newestConversationMtime({ dirs: [empty, used], logger });
    assert.equal(got.toISOString(), '2026-08-05T14:00:00.000Z');
    assert.deepEqual(warnings, [], 'an empty surface is normal, not a problem');
  });

  it('returns null when no directory is given', async () => {
    assert.equal(await newestConversationMtime({ dirs: [] }), null);
  });

  it('skips an uninstalled surface silently', async () => {
    // Most machines have one surface. A warning that fires on every healthy machine
    // is a warning nobody reads.
    const real = await makeConvDir({ 'a.db': '2026-08-05T14:00:00Z' });
    const { logger, warnings } = collectingLogger();
    const got = await newestConversationMtime({
      dirs: [nodePath.join(ROOT, 'not-installed', 'conversations'), real],
      logger
    });
    assert.equal(got.toISOString(), '2026-08-05T14:00:00.000Z');
    assert.deepEqual(warnings, []);
  });

  it('warns and keeps going when an installed surface cannot be read', async () => {
    // Only ENOENT means "not installed". A permission wall is an unanswered question.
    const real = await makeConvDir({ 'a.db': '2026-08-05T14:00:00Z' });
    const walled = await makeConvDir({ 'b.db': '2026-08-04T14:00:00Z' });
    const readdir = async (p, opts) => {
      if (p === walled) {
        const err = new Error(`EACCES: permission denied, scandir '${p}'`);
        err.code = 'EACCES';
        throw err;
      }
      return fsp.readdir(p, opts);
    };
    const { logger, warnings } = collectingLogger();
    const got = await newestConversationMtime({ dirs: [walled, real], readdir, logger });
    assert.equal(got.toISOString(), '2026-08-05T14:00:00.000Z');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /EACCES|permission/i);
  });

  it('survives one entry that cannot be stat-ed', async () => {
    const d = await makeConvDir({
      'good.db': '2026-08-05T14:00:00Z',
      'gone.db': '2026-08-04T14:00:00Z'
    });
    const stat = async (p) => {
      if (p.endsWith('gone.db')) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return fsp.stat(p);
    };
    const got = await newestConversationMtime({ dirs: [d], stat });
    assert.equal(got.toISOString(), '2026-08-05T14:00:00.000Z');
  });

  it('discards a future mtime without discarding the directory', async () => {
    // The ceiling has to be applied per file, here, where the file can be named.
    // Taking the max first and judging it afterwards throws away every believable
    // date in the same directory — which is the v1.26.66 failure wearing new clothes.
    const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
    const d = await makeConvDir({ 'bad.db': future, 'ok.db': '2026-08-05T14:00:00Z' });
    const { logger, warnings } = collectingLogger();
    const got = await newestConversationMtime({ dirs: [d], logger });
    assert.equal(got.toISOString(), '2026-08-05T14:00:00.000Z');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /future/i);
    assert.match(warnings[0], /bad\.db/, 'the warning must name the file');
  });

  it('never opens a conversation file', async () => {
    // The files hold the user's conversations. The collector's business is when,
    // never what. A behavioural test cannot catch a future edit that adds a read.
    const src = await fsp.readFile(
      new URL('../shared/scanners/gemini-conversations.js', import.meta.url), 'utf8');
    // Strip block comments and line comments including trailing ones. A stripper that
    // only removed whole comment lines left every inline comment in the text, so the
    // guard could both miss a call and trip over prose.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.match(code, /readdir/, 'sanity: the stripping must not have eaten the code');

    for (const forbidden of [
      /\breadFile\b/, /\breadFileSync\b/, /\bcreateReadStream\b/,
      // A destructured `open` is still an open.
      /\bopen\s*\(/,
      // Shelling out reads content just as effectively as opening the file does.
      /\bexecFile\b/, /\bspawn\b/, /\bsqlite/i
    ]) {
      assert.doesNotMatch(code, forbidden,
        `gemini-conversations.js must not read conversation content (${forbidden})`);
    }

    // Stronger than a blocklist: name what it is allowed to touch. A blocklist only
    // ever knows about the ways to read a file that someone already thought of.
    const fsMembers = [...code.matchAll(/\bfsp?\.(\w+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(fsMembers)].sort(), ['readdir', 'stat'],
      'the only filesystem calls here may be readdir and stat');
    assert.doesNotMatch(code, /import\s*\{[^}]*\}\s*from\s*['"]fs/,
      'a destructured fs import would slip past the member check above');
  });

  it('does not reach into the Cursor adapter', async () => {
    // The review's point: asserting which paths a sqlite spy received proves the spy
    // was called correctly, not that Cursor gained nothing. This is the structural
    // version of that claim.
    const src = await fsp.readFile(
      new URL('../shared/scanners/cursor.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /gemini-conversations/);
    assert.doesNotMatch(src, /extraDateSources/);
  });
});

describe('the adapter uses the freshest of every source', () => {
  it('emits the conversation date when the telemetry is frozen', async () => {
    // The measured state of Vin's machine: manager telemetry stuck on 2026-05-18,
    // manager conversations running to 2026-08-05.
    const conv = await makeConvDir({ 'c.db': '2026-08-05T14:37:00Z' });
    const { run } = fakeSqlite({
      '/db/state.vscdb': [current('Mon, 18 May 2026 04:09:19 GMT')]
    });
    const adapter = createAntigravityAdapter({
      dbPath: '/db/state.vscdb', runSqlite: run, conversationDirs: [conv]
    });
    const out = await adapter.readSince({});
    assert.deepEqual(out.sessions, [
      { tool: 'antigravity', date: '2026-08-05', count: 1, wall_seconds: 0 }
    ]);
  });

  it('does not move the answer backwards when the telemetry is fresher', async () => {
    const conv = await makeConvDir({ 'c.db': '2026-07-30T10:00:00Z' });
    const { run } = fakeSqlite({
      '/db/state.vscdb': [current('Wed, 05 Aug 2026 13:57:28 GMT')]
    });
    const adapter = createAntigravityAdapter({
      dbPath: '/db/state.vscdb', runSqlite: run, conversationDirs: [conv]
    });
    const out = await adapter.readSince({});
    assert.equal(out.sessions[0].date, '2026-08-05');
  });

  it('emits nothing when neither source has anything', async () => {
    const conv = await makeConvDir({});
    const { run } = fakeSqlite({ '/db/state.vscdb': [] });
    const adapter = createAntigravityAdapter({
      dbPath: '/db/state.vscdb', runSqlite: run, conversationDirs: [conv]
    });
    const out = await adapter.readSince({});
    assert.deepEqual(out.sessions, []);
    assert.deepEqual(out.events, []);
    assert.equal(out.heartbeat.tool, 'antigravity');
  });

  it('ignores a conversation dated in the future, and says so', async () => {
    // Without the ceiling one bad mtime is emitted once, the cursor advances past
    // every real date, and the tool goes silent permanently.
    const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
    const conv = await makeConvDir({ 'bad.db': future, 'ok.db': '2026-08-05T14:00:00Z' });
    const { run } = fakeSqlite({ '/db/state.vscdb': [] });
    const { logger, warnings } = collectingLogger();
    const adapter = createAntigravityAdapter({
      dbPath: '/db/state.vscdb', runSqlite: run, conversationDirs: [conv], logger
    });
    const out = await adapter.readSince({});
    assert.equal(out.sessions[0].date, '2026-08-05');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /future/i);
  });

  it('accepts a conversation a couple of hours ahead', async () => {
    // Timezone handling and ordinary clock drift move things by hours.
    const soon = new Date(Date.now() + 2 * 3600 * 1000);
    const conv = await makeConvDir({ 'c.db': soon.toISOString() });
    const { run } = fakeSqlite({ '/db/state.vscdb': [] });
    const adapter = createAntigravityAdapter({
      dbPath: '/db/state.vscdb', runSqlite: run, conversationDirs: [conv]
    });
    const out = await adapter.readSince({});
    assert.equal(out.sessions[0].date, toTaipeiYmd(soon));
  });

  it('still reports the telemetry when the conversation source throws', async () => {
    const { run } = fakeSqlite({
      '/db/state.vscdb': [current('Wed, 05 Aug 2026 13:57:28 GMT')]
    });
    const { logger, warnings } = collectingLogger();
    const adapter = createVscodeAdapter({
      tool: 'antigravity',
      dbPath: '/db/state.vscdb',
      runSqlite: run,
      logger,
      extraDateSources: [async () => { throw new Error('boom'); }]
    });
    const out = await adapter.readSince({});
    assert.equal(out.sessions[0].date, '2026-08-05');
    assert.equal(out.heartbeat.tool, 'antigravity');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /boom/);
  });

  it('re-emits a day beneath a cursor that got ahead', async () => {
    // v1.26.66 Requirement 6. The server upserts with GREATEST, so a re-emit is
    // idempotent; requiring the date to advance would suppress every day underneath.
    const conv = await makeConvDir({ 'c.db': '2026-08-05T14:00:00Z' });
    const { run } = fakeSqlite({ '/db/state.vscdb': [] });
    const adapter = createAntigravityAdapter({
      dbPath: '/db/state.vscdb', runSqlite: run, conversationDirs: [conv]
    });
    const out = await adapter.readSince({ antigravity: { last_session_date: '2026-08-06' } });
    assert.equal(out.sessions[0].date, '2026-08-05');
  });

  it('emits nothing when the cursor already holds the freshest day', async () => {
    const conv = await makeConvDir({ 'c.db': '2026-08-05T14:00:00Z' });
    const { run } = fakeSqlite({ '/db/state.vscdb': [] });
    const adapter = createAntigravityAdapter({
      dbPath: '/db/state.vscdb', runSqlite: run, conversationDirs: [conv]
    });
    const out = await adapter.readSince({ antigravity: { last_session_date: '2026-08-05' } });
    assert.deepEqual(out.sessions, []);
  });
});

describe('nothing else changes', () => {
  it('leaves Cursor reading state.vscdb and nothing else', async () => {
    const { run, queried } = fakeSqlite({
      '/db/cursor.vscdb': [current('Wed, 05 Aug 2026 13:57:28 GMT')]
    });
    const adapter = createCursorAdapter({ dbPath: '/db/cursor.vscdb', runSqlite: run });
    const out = await adapter.readSince({});
    assert.equal(out.sessions[0].date, '2026-08-05');
    assert.deepEqual(queried, ['/db/cursor.vscdb']);
  });

  it('still reads exactly the database an explicit dbPath names', async () => {
    const conv = await makeConvDir({ 'c.db': '2026-08-05T14:00:00Z' });
    const { run, queried } = fakeSqlite({
      '/db/explicit.vscdb': [current('Mon, 18 May 2026 04:09:19 GMT')]
    });
    const adapter = createAntigravityAdapter({
      dbPath: '/db/explicit.vscdb', runSqlite: run, conversationDirs: [conv]
    });
    await adapter.readSince({});
    assert.deepEqual(queried, ['/db/explicit.vscdb']);
  });

  it('derives the conversation directories from the home directory by default', async () => {
    // Nothing passes conversationDirs in production: hooks/ownmind-usage-scanner.js
    // constructs the adapter as factory({ scannerVersion, machine }). A fix that only
    // worked when a test supplied the paths would be inert where it matters.
    const home = await fsp.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'ownmind-ag-home-'));
    const conv = nodePath.join(home, '.gemini', 'antigravity', 'conversations');
    await fsp.mkdir(conv, { recursive: true });
    const f = nodePath.join(conv, 'c.db');
    await fsp.writeFile(f, 'x');
    const t = new Date('2026-08-05T14:00:00Z');
    await fsp.utimes(f, t, t);

    const { run } = fakeSqlite({ '/db/state.vscdb': [] });
    const adapter = createAntigravityAdapter({
      dbPath: '/db/state.vscdb', runSqlite: run, homeDir: home
    });
    const out = await adapter.readSince({});
    assert.equal(adapter.tool, 'antigravity');
    assert.equal(out.sessions[0].date, '2026-08-05');
    await fsp.rm(home, { recursive: true, force: true });
  });
});
