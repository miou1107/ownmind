// v1.26.73 — one heartbeat row per machine, not per person.
//
// `collector_heartbeat` was UNIQUE (user_id, tool), so somebody with two computers had
// them overwriting each other all day. Watched happen on production 2026-08-05: at 11:50
// Vin's rows read `claude-code` on TANK and the other four on Vincent.local; after a
// manual scan on the Windows box at 12:30 all five read TANK, and the Mac's status was
// gone with no record it had ever reported.
//
// The consequence is not cosmetic. **A dead collector on one machine is invisible while
// another machine of the same person is alive**, because the heartbeat is fresh and the
// usage is flowing. It is also why the v1.26.72 self-check could only say
// "the server records this against another computer" instead of answering the question.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { createEventsRouter } = await import('../src/routes/usage/events.js');
const { buildSelfCheckReport } = await import('../shared/scanners/selfcheck.js');

// ────────────────────────────────────────────────────────────
// The migration
// ────────────────────────────────────────────────────────────

describe('db/019 — the key gains the machine', () => {
  const sql = fs.readFileSync(
    path.join(repoRoot, 'db', '019_collector_heartbeat_per_machine.sql'), 'utf8');

  it('drops the two-column uniqueness and adds the three-column one', () => {
    assert.match(sql, /DROP CONSTRAINT IF EXISTS collector_heartbeat_user_id_tool_key/i);
    // Either a constraint or a unique index — ON CONFLICT infers from both. The index
    // form is what allows IF NOT EXISTS, which Postgres does not offer for constraints.
    assert.match(sql,
      /UNIQUE\s+INDEX[\s\S]{0,120}\(\s*user_id\s*,\s*tool\s*,\s*machine\s*\)|UNIQUE\s*\(\s*user_id\s*,\s*tool\s*,\s*machine\s*\)/i);
  });

  it('makes machine NOT NULL first', () => {
    // Postgres treats NULLs as distinct in a unique index, so a NULL machine would insert
    // a brand new row on every single heartbeat. The column has to be definite before it
    // can be part of the key.
    assert.match(sql, /SET NOT NULL/i);
    assert.match(sql, /UPDATE collector_heartbeat[\s\S]*machine IS NULL/i);
  });

  it('is safe to run twice', () => {
    assert.match(sql, /IF EXISTS/i);
    assert.match(sql, /IF NOT EXISTS/i);
  });
});

// ────────────────────────────────────────────────────────────
// Ingestion
// ────────────────────────────────────────────────────────────

function ingest({ heartbeat, capture }) {
  const query = async (sql, params) => {
    capture.push({ sql, params });
    return { rows: [], rowCount: 0 };
  };
  const app = createEventsRouter({
    query,
    auth: (req, _res, next) => { req.user = { id: 7 }; next(); }
  });
  return { app, body: { events: [], heartbeat } };
}

async function post(router, body) {
  const express = (await import('express')).default;
  const a = express();
  a.use(express.json());
  a.use('/api/usage/events', router);
  const server = a.listen(0);
  try {
    const { port } = server.address();
    await fetch(`http://127.0.0.1:${port}/api/usage/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } finally {
    server.close();
  }
}

const heartbeatSql = (capture) =>
  capture.find((c) => /INSERT INTO collector_heartbeat/i.test(c.sql));

describe('writing a heartbeat', () => {
  it('conflicts on the machine as well as the tool', async () => {
    const capture = [];
    const { app, body } = ingest({
      capture,
      heartbeat: { tool: 'claude-code', machine: 'TANK', os: 'win32', scanner_version: '1.26.73' }
    });
    await post(app, body);
    const hb = heartbeatSql(capture);
    assert.ok(hb, 'the heartbeat must have been written');
    assert.match(hb.sql, /ON CONFLICT\s*\(\s*user_id\s*,\s*tool\s*,\s*machine\s*\)/i);
  });

  it('never writes a null machine, because null cannot be part of the key', async () => {
    // An older client, or the MCP before v1.16, sends no machine. Left as NULL it would
    // insert an unbounded number of rows: one per heartbeat, forever.
    const capture = [];
    const { app, body } = ingest({ capture, heartbeat: { tool: 'claude-code' } });
    await post(app, body);
    const hb = heartbeatSql(capture);
    assert.ok(hb);
    const machineParam = hb.params[3];
    assert.notEqual(machineParam, null, 'a heartbeat with no machine must still be identifiable');
    assert.equal(typeof machineParam, 'string');
    assert.ok(machineParam.length > 0);
  });

  it('does not overwrite the machine name it conflicted on', async () => {
    // Updating `machine` in the DO UPDATE was harmless when it was the only row. Now it
    // is part of the identity, and writing it would be writing the key.
    const capture = [];
    const { app, body } = ingest({
      capture, heartbeat: { tool: 'claude-code', machine: 'TANK' }
    });
    await post(app, body);
    const hb = heartbeatSql(capture);
    const doUpdate = hb.sql.slice(hb.sql.search(/DO UPDATE/i));
    assert.doesNotMatch(doUpdate, /^\s*machine\s*=/m,
      'the DO UPDATE must not assign machine; it is part of the conflict target now');
  });
});

// ────────────────────────────────────────────────────────────
// The self-check, which is what this unblocks
// ────────────────────────────────────────────────────────────

const NOW = '2026-08-06T00:00:00.000Z';
const FRESH = '2026-08-05T23:59:30.000Z';

const scan = (tool) => ({ tool, sent: 1, accepted: 1, sessions: 0, reason: 'ok' });
const row = (tool, machine, over = {}) => ({
  tool, machine, os: 'darwin', scanner_version: '1.26.73',
  last_reported_at: FRESH, reason: 'ok', events_24h: 1, ...over
});

describe('a self-check on a machine that shares an account', () => {
  it('finds its own row among several for the same tool', async () => {
    const r = buildSelfCheckReport({
      machine: 'Vincent.local',
      scanned: [scan('claude-code')],
      serverTools: [row('claude-code', 'TANK'), row('claude-code', 'Vincent.local')],
      serverTime: NOW
    });
    assert.equal(r.rows[0].verdict, 'confirmed');
    assert.equal(r.rows[0].server_machine, 'Vincent.local');
  });

  it('finds it whichever order the server returns them in', async () => {
    const r = buildSelfCheckReport({
      machine: 'Vincent.local',
      scanned: [scan('claude-code')],
      serverTools: [row('claude-code', 'Vincent.local'), row('claude-code', 'TANK')],
      serverTime: NOW
    });
    assert.equal(r.rows[0].verdict, 'confirmed');
  });

  it('fails when only the other computer has a row', async () => {
    // The whole point. Before this change the account looked healthy and this machine's
    // silence was invisible; now the machine says so about itself.
    const r = buildSelfCheckReport({
      machine: 'Vincent.local',
      scanned: [scan('claude-code')],
      serverTools: [row('claude-code', 'TANK')],
      serverTime: NOW
    });
    assert.equal(r.rows[0].verdict, 'other_machine');
    assert.equal(r.rows[0].server_machine, 'TANK');
  });

  it('fails rather than borrowing a sibling machine\'s freshness', async () => {
    // This machine's own row is stale; another machine of the same account is current.
    // Picking by tool alone would have read the sibling's row and reported confirmed.
    const r = buildSelfCheckReport({
      machine: 'Vincent.local',
      scanned: [scan('claude-code')],
      serverTools: [
        row('claude-code', 'TANK'),
        row('claude-code', 'Vincent.local', { last_reported_at: '2026-08-05T20:00:00.000Z' })
      ],
      serverTime: NOW
    });
    assert.equal(r.rows[0].verdict, 'not_recorded');
    assert.equal(r.ok, false);
  });

  it('still matches case-insensitively across the machines it sifts', async () => {
    const r = buildSelfCheckReport({
      machine: 'Vincent.local',
      scanned: [scan('claude-code')],
      serverTools: [row('claude-code', 'TANK'), row('claude-code', ' VINCENT.LOCAL ')],
      serverTime: NOW
    });
    assert.equal(r.rows[0].verdict, 'confirmed');
  });
});

// ────────────────────────────────────────────────────────────
// Readers that assumed one row per (user, tool)
// ────────────────────────────────────────────────────────────

describe('queries that used to get exactly one row per tool', () => {
  // Three places select scanner versions out of collector_heartbeat and render one entry
  // per tool. With a row per machine they would each show a person twice — once per
  // computer — and "which version is X on" would have two answers.
  //
  // Newest wins: the version somebody is effectively on is the one their most recently
  // active machine reports.
  const cases = [
    ['src/routes/me.js', 'my own tool versions'],
    ['src/routes/me-narrative.js', 'every member\'s tool versions']
  ];

  for (const [file, what] of cases) {
    it(`${file} collapses ${what} to one row per tool`, () => {
      const src = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      // Only the queries that project a version. An EXISTS probe against the same table
      // asks "is this person instrumented at all" and is right to ignore machines.
      const queries = [];
      const re = /FROM\s+collector_heartbeat/gi;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const start = src.lastIndexOf('SELECT', m.index);
        const end = src.indexOf('`', m.index);
        if (start >= 0 && end > start) queries.push(src.slice(start, end));
      }
      const versionQueries = queries.filter((q) => /scanner_version/i.test(q));
      assert.ok(versionQueries.length > 0, `no version query found in ${file}`);
      for (const q of versionQueries) {
        assert.match(q, /DISTINCT ON\s*\([^)]*tool[^)]*\)/i,
          `a version query in ${file} still assumes one row per tool:\n${q}`);
      }
    });
  }
});

// ────────────────────────────────────────────────────────────
// The new surface this key creates
// ────────────────────────────────────────────────────────────

describe('a client-supplied hostname is part of the key now', () => {
  it('caps how many machines one person can register for one tool', async () => {
    // Raised by review. Before this change the key had no client-controlled component,
    // so no client could make the table grow. Now a machine whose hostname changes on
    // every boot — or an account sending random ones — inserts a row each time, and the
    // per-row rate limit cannot help because every row is a first insert.
    const capture = [];
    const { app, body } = ingest({
      capture, heartbeat: { tool: 'claude-code', machine: 'TANK' }
    });
    await post(app, body);
    const hb = heartbeatSql(capture);
    assert.match(hb.sql, /count\(\*\)/i,
      'the insert must count the machines already registered for this (user, tool)');
    assert.match(hb.sql, /<\s*\d+/,
      'and compare that count against a limit');
  });

  it('still lets a machine already on record update itself past the cap', async () => {
    // The cap must bound new machines, not stop a real one from reporting. A team where
    // somebody hits the limit must not have their existing computers go silent.
    const capture = [];
    const { app, body } = ingest({
      capture, heartbeat: { tool: 'claude-code', machine: 'TANK' }
    });
    await post(app, body);
    const hb = heartbeatSql(capture);
    assert.match(hb.sql, /EXISTS/i,
      'an already-registered machine must bypass the cap');
  });

  it('every parameter in the INSERT ... SELECT list carries an explicit type', () => {
    // v1.26.76. Production, eight seconds after v1.26.75 started:
    //   heartbeat update failed {"error":"inconsistent types deduced for parameter $2"}
    //
    // v1.26.73 changed this write from `INSERT ... VALUES` to `INSERT ... SELECT ... WHERE`
    // so the machine cap could ride in the same round trip. In the VALUES form Postgres
    // takes each parameter's type from the column it is being written into. In the SELECT
    // form the query is analysed on its own first, so a bare `$2` in the select list is
    // `unknown` and settles as text — while the same `$2` in `WHERE tool = $2` is deduced
    // as varchar from the column. Two deductions for one parameter, and the statement
    // cannot be prepared at all. Every heartbeat failed.
    //
    // Nothing in this suite could have caught it: every test here hands the route a fake
    // `query`, so the statement is never parsed by anything that knows SQL. This asserts
    // the property that makes it parseable, and the fix was additionally checked with
    // PREPARE against the production database before shipping.
    const src = fs.readFileSync(
      path.join(repoRoot, 'src', 'routes', 'usage', 'events.js'), 'utf8');
    // Strip SQL comments first. The comment explaining this rule quotes the error
    // message, which contains a "$2" that is not a parameter at all.
    const stmt = src.slice(src.indexOf('INSERT INTO collector_heartbeat'))
      .replace(/--[^\n]*/g, '');
    const selectList = stmt.slice(stmt.search(/SELECT/), stmt.search(/WHERE EXISTS/i));
    const params = selectList.match(/\$\d+(?:::[a-z]+)?/gi) ?? [];
    assert.ok(params.length >= 6, `expected the inserted values, found ${params.length}`);
    for (const p of params) {
      assert.match(p, /::/,
        `${p} is written into a column but compared elsewhere; without a cast Postgres `
        + 'deduces two types for it and refuses the statement');
    }
  });

  it('trims and bounds the hostname before it becomes an identity', async () => {
    const { normaliseMachine } = await import('../src/routes/usage/events.js');
    assert.equal(normaliseMachine('  TANK  '), 'TANK', 'space must not make a second machine');
    assert.equal(normaliseMachine(''), 'unknown');
    assert.equal(normaliseMachine(null), 'unknown');
    assert.equal(normaliseMachine(undefined), 'unknown');
    assert.equal(normaliseMachine(123), 'unknown', 'a non-string cannot be an identity');
    assert.equal(normaliseMachine('x'.repeat(500)).length, 128,
      'the column is VARCHAR(128); an over-long name must be cut, not rejected');
  });
});
