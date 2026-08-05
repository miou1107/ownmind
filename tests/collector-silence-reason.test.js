// v1.26.69 — a silent collector must say why.
//
// v1.26.50 already split the honest states: flowing / silent / not_installed / offline.
// `silent` means "heartbeat arrives, zero usage rows", and it has at least five distinct
// causes that the console cannot tell apart:
//
//   1. the sqlite3 CLI is missing, so Tier 2 cannot be read at all
//   2. the tool is not installed on that machine
//   3. the tool is installed but unused
//   4. the collector is reading a directory the tool abandoned (v1.26.66)
//   5. the machine changed account, so the cursor says the day was already reported
//
// Diagnosing one silent cell on one machine took an hour on 2026-08-05, and the answer
// was cause 4. The collector knew it at the moment it gave up, wrote it to a local log
// nobody reads, and sent the server a heartbeat that said "active".

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import nodePath from 'path';
import nodeOs from 'os';
import express from 'express';

const { createEventsRouter } = await import('../src/routes/usage/events.js');

const { createVscodeAdapter } = await import('../shared/scanners/vscode-telemetry.js');
const { createAntigravityAdapter } = await import('../shared/scanners/antigravity.js');
const { REASONS, isReason } = await import('../shared/scanners/reasons.js');
const { accountFingerprint, cursorForAccount } = await import('../shared/scanners/base.js');
const { observedUsers } = await import('../client/src/pages/System/observed-users.js');

const current = (v) => ({ key: 'telemetry.currentSessionDate', value: v });

function fakeSqlite(byPath) {
  return async ({ dbPath }) => {
    if (!(dbPath in byPath)) throw new Error(`unable to open database file: ${dbPath}`);
    return byPath[dbPath];
  };
}

/** A runSqlite that fails the way a missing CLI fails. */
const sqliteCliMissing = async () => {
  const err = new Error("spawn sqlite3 ENOENT");
  err.code = 'ENOENT';
  throw err;
};

let ROOT;
before(async () => {
  ROOT = await fsp.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'ownmind-reason-'));
});
after(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
});

let seq = 0;
async function emptyDir() {
  const d = nodePath.join(ROOT, `d-${seq += 1}`);
  await fsp.mkdir(d, { recursive: true });
  return d;
}

describe('the reason vocabulary is closed', () => {
  it('is exactly the six codes the spec names', () => {
    assert.deepEqual([...REASONS].sort(), [
      'account_changed', 'no_install', 'no_new_activity',
      'ok', 'sqlite_missing', 'unreadable'
    ]);
  });

  it('rejects anything else', () => {
    assert.equal(isReason('ok'), true);
    assert.equal(isReason('sqlite_missing'), true);
    assert.equal(isReason('active'), false);
    assert.equal(isReason(''), false);
    assert.equal(isReason(null), false);
    assert.equal(isReason('a'.repeat(64)), false);
  });

  it('every code fits the column it is stored in', () => {
    assert.ok(REASONS.size > 0, 'an empty set would pass this vacuously');
    for (const r of REASONS) assert.ok(r.length <= 32, `${r} is too long`);
  });
});

describe('an adapter says why it produced nothing', () => {
  it('reports no_install when nothing of the tool is on this machine', async () => {
    const adapter = createVscodeAdapter({
      tool: 'antigravity',
      dbPaths: ['/nope/state.vscdb'],
      exists: async () => false,
      runSqlite: fakeSqlite({})
    });
    const out = await adapter.readSince({});
    assert.equal(out.reason, 'no_install');
    assert.deepEqual(out.sessions, []);
  });

  it('reports no_install for a single-path adapter whose file is not there', async () => {
    // Cursor names one database rather than a candidate list, so nothing filtered it by
    // existence and the sqlite CLI's "unable to open database file" arrived as a plain
    // failure. A machine without Cursor therefore reported `unreadable`, which is the
    // exact confusion this change exists to remove: one means go install sqlite3 or
    // check permissions, the other means there is nothing here to read.
    const adapter = createVscodeAdapter({
      tool: 'cursor',
      dbPath: '/not/here/state.vscdb',
      exists: async () => false,
      runSqlite: async () => { throw new Error('unable to open database file'); }
    });
    const out = await adapter.readSince({});
    assert.equal(out.reason, 'no_install');
  });

  it('still says unreadable when the file is there and will not open', async () => {
    // Measured on a real machine: Cursor's state.vscdb exists, is readable, holds a
    // date, and `sqlite3 -readonly` fails on it anyway.
    const adapter = createVscodeAdapter({
      tool: 'cursor',
      dbPath: '/here/state.vscdb',
      exists: async () => true,
      runSqlite: async () => { throw new Error('unable to open database file'); }
    });
    const out = await adapter.readSince({});
    assert.equal(out.reason, 'unreadable');
  });

  it('reports sqlite_missing when the CLI cannot be executed', async () => {
    // On Windows this is a one-command fix, and today it is indistinguishable from
    // "the tool is not installed".
    const adapter = createVscodeAdapter({
      tool: 'cursor',
      dbPaths: ['/c/state.vscdb'],
      exists: async () => true,
      runSqlite: sqliteCliMissing
    });
    const out = await adapter.readSince({});
    assert.equal(out.reason, 'sqlite_missing');
  });

  it('reports unreadable when the database is there but will not open', async () => {
    const adapter = createVscodeAdapter({
      tool: 'cursor',
      dbPaths: ['/c/state.vscdb'],
      exists: async () => true,
      runSqlite: async () => { throw new Error('disk I/O error'); }
    });
    const out = await adapter.readSince({});
    assert.equal(out.reason, 'unreadable');
  });

  it('reports no_new_activity when it read cleanly and the day has not moved', async () => {
    // The healthy quiet case. It is also what the v1.26.66 defect produced for eleven
    // weeks, so this reason on a tool someone is visibly using is itself the signal.
    const adapter = createVscodeAdapter({
      tool: 'antigravity',
      dbPath: '/db/state.vscdb',
      runSqlite: fakeSqlite({ '/db/state.vscdb': [current('Wed, 05 Aug 2026 13:57:28 GMT')] })
    });
    const out = await adapter.readSince({ antigravity: { last_session_date: '2026-08-05' } });
    assert.deepEqual(out.sessions, []);
    assert.equal(out.reason, 'no_new_activity');
  });

  it('reports ok when it actually has something to send', async () => {
    const adapter = createVscodeAdapter({
      tool: 'antigravity',
      dbPath: '/db/state.vscdb',
      runSqlite: fakeSqlite({ '/db/state.vscdb': [current('Wed, 05 Aug 2026 13:57:28 GMT')] })
    });
    const out = await adapter.readSince({});
    assert.equal(out.sessions.length, 1);
    assert.equal(out.reason, 'ok');
  });

  it('still sends its heartbeat whatever the reason', async () => {
    // Reporting why a collector is quiet must not become a reason for it to go quiet.
    const adapter = createVscodeAdapter({
      tool: 'cursor',
      dbPaths: ['/c/state.vscdb'],
      exists: async () => true,
      runSqlite: sqliteCliMissing
    });
    const out = await adapter.readSince({});
    assert.equal(out.heartbeat.tool, 'cursor');
    assert.equal(out.heartbeat.reason, 'sqlite_missing');
  });

  it('does not call a conversation source no_install when conversations exist', async () => {
    // v1.26.68 gave Antigravity a second source. A machine with no state.vscdb but a
    // live conversation store is installed, not absent.
    const conv = nodePath.join(ROOT, 'conv-live');
    await fsp.mkdir(conv, { recursive: true });
    const f = nodePath.join(conv, 'c.db');
    await fsp.writeFile(f, 'x');
    const t = new Date('2026-08-05T14:00:00Z');
    await fsp.utimes(f, t, t);

    const adapter = createAntigravityAdapter({
      dbPaths: ['/nope/state.vscdb'],
      exists: async () => false,
      runSqlite: fakeSqlite({}),
      conversationDirs: [conv]
    });
    const out = await adapter.readSince({});
    assert.equal(out.reason, 'ok');
    assert.equal(out.sessions[0].date, '2026-08-05');
  });
});

describe('a cursor knows which account it belongs to', () => {
  it('is a hash, never the credential', () => {
    const fp = accountFingerprint({ apiUrl: 'https://x/ownmind', apiKey: 'super-secret-key' });
    assert.ok(typeof fp === 'string' && fp.length > 0);
    assert.ok(!fp.includes('super-secret-key'));
    assert.ok(/^[0-9a-f]+$/.test(fp), 'a hex digest, not anything reversible');
  });

  it('changes when the key changes and when the server changes', () => {
    const a = accountFingerprint({ apiUrl: 'https://x/ownmind', apiKey: 'k1' });
    const b = accountFingerprint({ apiUrl: 'https://x/ownmind', apiKey: 'k2' });
    const c = accountFingerprint({ apiUrl: 'https://y/ownmind', apiKey: 'k1' });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });

  it('ignores a trailing slash on the server URL', () => {
    // postBatch strips trailing slashes before posting, so these two configurations are
    // the same account talking to the same server. Hashing them differently would call
    // it an account change and drop every day cursor on the machine.
    assert.equal(
      accountFingerprint({ apiUrl: 'https://x/ownmind', apiKey: 'k' }),
      accountFingerprint({ apiUrl: 'https://x/ownmind/', apiKey: 'k' })
    );
  });

  it('is stable across calls', () => {
    const args = { apiUrl: 'https://x/ownmind', apiKey: 'k1' };
    const fp = accountFingerprint(args);
    assert.ok(fp.length >= 16, 'an empty string would pass this vacuously');
    assert.equal(fp, accountFingerprint(args));
  });

  it('keeps the cursor when the account matches', () => {
    const fp = accountFingerprint({ apiUrl: 'u', apiKey: 'k' });
    const state = { account: fp, antigravity: { last_session_date: '2026-07-23' } };
    const out = cursorForAccount(state, fp);
    assert.equal(out.changed, false);
    assert.deepEqual(out.state.antigravity, { last_session_date: '2026-07-23' });
  });

  it('discards the cursor when the account changed', () => {
    // Observed on TANK: the cursor said antigravity was reported up to 2026-07-23, the
    // account configured there had no such row, and the account that did have one could
    // not have produced it from its own machine.
    const mine = accountFingerprint({ apiUrl: 'u', apiKey: 'mine' });
    const theirs = accountFingerprint({ apiUrl: 'u', apiKey: 'theirs' });
    const state = { account: theirs, antigravity: { last_session_date: '2026-07-23' } };
    const out = cursorForAccount(state, mine);
    assert.equal(out.changed, true);
    assert.equal(out.state.antigravity, undefined, 'the other account keeps nothing here');
    assert.equal(out.state.account, mine);
  });

  it('drops day claims but keeps read positions when the account changes', () => {
    // These two kinds of cursor entry mean different things.
    //
    // `last_session_date` is a claim that a particular day was already reported. That
    // day belongs to whoever worked it, so the new account must not inherit the claim.
    //
    // `byte_offset` is a position marker meaning "this file has been read this far".
    // Keeping it is exactly the policy this change wants: the new account starts from
    // now. Dropping it would replay the whole machine's history into the new account,
    // which is the misattribution the policy exists to prevent.
    const mine = accountFingerprint({ apiUrl: 'u', apiKey: 'mine' });
    const theirs = accountFingerprint({ apiUrl: 'u', apiKey: 'theirs' });
    const out = cursorForAccount({
      account: theirs,
      antigravity: { last_session_date: '2026-07-23' },
      cursor: { last_session_date: '2026-07-20' },
      'claude-code:/home/u/a.jsonl': { byte_offset: 1207995 },
      session_cumulative: { 'claude-code': { x: 1 } }
    }, mine);

    assert.equal(out.changed, true);
    assert.equal(out.state.antigravity, undefined);
    assert.equal(out.state.cursor, undefined);
    assert.deepEqual(out.state['claude-code:/home/u/a.jsonl'], { byte_offset: 1207995 });
  });

  it('treats a first-ever install as new, not as a change', () => {
    // No cursor file at all still means "collect this machine's history".
    const fp = accountFingerprint({ apiUrl: 'u', apiKey: 'k' });
    const out = cursorForAccount({}, fp);
    assert.equal(out.changed, false, 'nothing was taken from anyone');
    assert.equal(out.state.account, fp);
  });

  it('treats a pre-v1.26.69 cursor as belonging to whoever is configured now', () => {
    // Cursor files written before this change carry no fingerprint. Calling that an
    // account change would reset every existing install on upgrade.
    const fp = accountFingerprint({ apiUrl: 'u', apiKey: 'k' });
    const legacy = { antigravity: { last_session_date: '2026-07-23' } };
    const out = cursorForAccount(legacy, fp);
    assert.equal(out.changed, false);
    assert.deepEqual(out.state.antigravity, { last_session_date: '2026-07-23' });
    assert.equal(out.state.account, fp, 'and it is stamped so the next switch is caught');
  });
});

describe('what the heartbeat actually sends to the database', () => {
  // Driving the real route with an injected query, rather than grepping the source for
  // SQL. A regex over a source file passes whether or not the statement does what it
  // says, which the review of this change pointed out and was right about.

  async function heartbeatCall(heartbeat) {
    const captured = [];
    const query = async (sql, params) => {
      captured.push({ sql, params });
      if (/FROM usage_tracking_exemption/.test(sql)) return { rows: [] };
      return { rows: [], rowCount: 0 };
    };
    const router = createEventsRouter({
      query,
      auth: (req, _res, next) => { req.user = { id: 7 }; next(); },
      recomputeDaily: async () => ({ skipped: true })
    });
    const app = express();
    app.use(express.json());
    app.use('/api/usage/events', router);

    await new Promise((resolve, reject) => {
      const req = {
        method: 'POST',
        url: '/api/usage/events', path: '/api/usage/events',
        headers: { 'content-type': 'application/json' },
        body: { events: [], heartbeat }
      };
      const res = {
        statusCode: 200, _headers: {},
        setHeader(k, v) { this._headers[k] = v; },
        getHeader(k) { return this._headers[k]; },
        status(c) { this.statusCode = c; return this; },
        json() { resolve(); }, send() { resolve(); }, end() { resolve(); }
      };
      try { app.handle(req, res, (e) => e ? reject(e) : resolve()); } catch (e) { reject(e); }
    });

    return captured.find((c) => /INSERT INTO collector_heartbeat/.test(c.sql));
  }

  it('passes a recognised reason through as a parameter', async () => {
    const call = await heartbeatCall({ tool: 'cursor', reason: 'sqlite_missing' });
    assert.ok(call, 'expected the heartbeat upsert to run');
    assert.equal(call.params[5], 'sqlite_missing');
    assert.equal(call.params[6], true, 'and to say that a reason was supplied');
  });

  it('clears the stored reason when a collector sends one it cannot store', async () => {
    // A newer collector reporting something this server does not know is still
    // reporting a change. Keeping the previous `ok` would show a healthy state for a
    // collector that has started failing, which is the failure this change exists to
    // end. The review caught the first implementation doing exactly that.
    const call = await heartbeatCall({ tool: 'cursor', reason: 'db_locked' });
    assert.equal(call.params[5], null, 'unknown codes are not stored');
    assert.equal(call.params[6], true, 'but the row is still updated to clear the old one');
  });

  it('leaves the stored reason alone when the heartbeat carries none', async () => {
    // The MCP and the scanner share one row per (user, tool) and only the scanner knows
    // a reason. If a reasonless MCP heartbeat nulled it out, the two would disagree on
    // every beat and the 30-second rate limit would stop working for the busiest tool.
    const call = await heartbeatCall({ tool: 'claude-code', machine: 'm' });
    assert.equal(call.params[5], null);
    assert.equal(call.params[6], false, 'no reason supplied, so do not touch the column');
  });

  it('keeps the rate limit and gives a reason change its own way through', async () => {
    const call = await heartbeatCall({ tool: 'cursor', reason: 'ok' });
    assert.match(call.sql, /last_reported_at\s*<\s*NOW\(\)\s*-\s*INTERVAL/);
    assert.match(call.sql, /IS DISTINCT FROM/);
  });
});

describe('the console shows the reason beside silent', () => {
  const userRow = (over = {}) => ({
    user_id: 1, user_name: 'A', installed: true, any_active: true,
    clients: [{ tool: 'antigravity', status: 'active', reason: 'sqlite_missing' }],
    ...over
  });

  it('attaches the reason to a silent user', () => {
    const rows = observedUsers({ users: [userRow()] }, { users: [] });
    assert.equal(rows[0].state, 'silent');
    assert.deepEqual(rows[0].reasons, [{ tool: 'antigravity', reason: 'sqlite_missing' }]);
  });

  it('leaves the four states exactly as they were', () => {
    // The reason is an attribute of the state, not a fifth state.
    const flowing = observedUsers(
      { users: [userRow()] },
      { users: [{ user: { id: 1 }, totals: { message_count: 3 } }] });
    assert.equal(flowing[0].state, 'flowing');

    const notInstalled = observedUsers(
      { users: [userRow({ installed: false, clients: [] })] }, { users: [] });
    assert.equal(notInstalled[0].state, 'not_installed');

    const offline = observedUsers(
      { users: [userRow({ any_active: false })] }, { users: [] });
    assert.equal(offline[0].state, 'offline');
  });

  it('reports nothing rather than guessing when the collector is too old to say', () => {
    const rows = observedUsers(
      { users: [userRow({ clients: [{ tool: 'antigravity', status: 'active' }] })] },
      { users: [] });
    assert.equal(rows[0].state, 'silent');
    assert.deepEqual(rows[0].reasons, []);
  });
});
