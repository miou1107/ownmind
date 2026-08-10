// v1.26.72 — GET /api/usage/self-check
//
// The one endpoint a member can point at their own machine and ask "did my data arrive".
// It has to be usable by a member, which means it must not be able to name anyone else.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startServer } from './helpers/app-server.js';

const { createSelfCheckRouter } = await import('../src/routes/usage/self-check.js');

const NOW = new Date('2026-08-06T00:00:00.000Z');

function app({ rows = [], counts = [], userId = 7, onQuery = null } = {}) {
  const seen = [];
  const query = async (sql, params) => {
    seen.push({ sql, params });
    onQuery?.(sql, params);
    return { rows: /collector_heartbeat/.test(sql) ? rows : counts };
  };
  const auth = (req, _res, next) => { req.user = userId ? { id: userId } : null; next(); };
  const a = express();
  a.use('/api/usage/self-check', createSelfCheckRouter({
    query, auth, now: () => NOW, serverVersion: '1.26.72'
  }));
  return { a, seen };
}

/**
 * v1.26.139 — the address is read after 'listening', not on the line after listen().
 *
 * `a.listen(0)` binds asynchronously, so `server.address()` on the next line can be null. In a
 * parallel full-suite run that put `undefined` into the URL and the failure read
 * `[TypeError: fetch failed] { cause: Error: bad port }`, landing on whichever test the
 * scheduler reached first. Each app is built per test here, so this remains one server per
 * call; only the waiting and the check are new.
 */
async function get(a) {
  const server = await startServer(a);
  try {
    const res = await fetch(`${server.url}/api/usage/self-check`);
    return { status: res.status, body: await res.json() };
  } finally {
    await server.close();
  }
}

describe('GET /api/usage/self-check', () => {
  it('returns the caller\'s heartbeat rows', async () => {
    const { a } = app({
      rows: [{
        tool: 'claude-code', machine: 'Vincent.local', os: 'darwin',
        scanner_version: '1.26.72',
        last_reported_at: new Date('2026-08-05T23:59:30.000Z'),
        last_event_ts: new Date('2026-08-05T23:59:00.000Z'), reason: 'ok'
      }],
      counts: [{ tool: 'claude-code', events_24h: '12' }]
    });
    const { status, body } = await get(a);
    assert.equal(status, 200);
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].tool, 'claude-code');
    assert.equal(body.tools[0].machine, 'Vincent.local');
    assert.equal(body.tools[0].events_24h, 12, 'a count must come back as a number');
  });

  it('returns the server clock, because the client cannot trust its own', async () => {
    const { a } = app();
    const { body } = await get(a);
    assert.equal(body.server_time, NOW.toISOString());
  });

  it('returns the server version, so an old client can be told to upgrade', async () => {
    const { a } = app();
    const { body } = await get(a);
    assert.equal(body.server_version, '1.26.72');
  });

  it('scopes every query to the authenticated user', async () => {
    // A member runs this on their own machine, so it cannot be admin-only, and it
    // therefore must not be able to reach anybody else's rows.
    const { a, seen } = app({ userId: 7 });
    await get(a);
    assert.ok(seen.length >= 1);
    for (const { sql, params } of seen) {
      assert.match(sql, /user_id\s*=\s*\$1/,
        'every query must filter on user_id from the session');
      assert.equal(params[0], 7);
    }
  });

  it('takes no user parameter at all', async () => {
    const { a } = app({ userId: 7 });
    // Not the shared get(), because this one needs a query string on the URL.
    const server = await startServer(a);
    try {
      const res = await fetch(`${server.url}/api/usage/self-check?user_id=9`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.user_id, 7, 'a query string must not be able to choose the user');
    } finally {
      await server.close();
    }
  });

  it('forbids caching, because the url is identical for every member', async () => {
    // Authentication is a header, so a shared cache keyed on the url would happily serve
    // one member's machine names and counts to the next one. helmet sets no
    // Cache-Control of its own; this was checked rather than assumed.
    const { a } = app();
    // Not the shared get(), because this one reads a response header rather than the body.
    const server = await startServer(a);
    try {
      const res = await fetch(`${server.url}/api/usage/self-check`);
      assert.match(res.headers.get('cache-control') ?? '', /no-store/);
    } finally {
      await server.close();
    }
  });

  it('401s when there is no session', async () => {
    const { a } = app({ userId: null });
    const { status } = await get(a);
    assert.equal(status, 401);
  });

  it('reports a tool with zero recent events rather than dropping it', async () => {
    // "Heartbeat but no events" is the hazard state. Omitting the row would hide it.
    const { a } = app({
      rows: [{
        tool: 'cursor', machine: 'Vincent.local', os: 'darwin',
        scanner_version: '1.26.72',
        last_reported_at: new Date('2026-08-05T23:59:30.000Z'),
        last_event_ts: null, reason: 'unreadable'
      }],
      counts: []
    });
    const { body } = await get(a);
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].events_24h, 0);
    assert.equal(body.tools[0].reason, 'unreadable');
  });

  it('answers with an empty list rather than an error for a machine that never reported', async () => {
    const { a } = app({ rows: [], counts: [] });
    const { status, body } = await get(a);
    assert.equal(status, 200);
    assert.deepEqual(body.tools, []);
  });

  it('does not return an api key or anything else from the users table', async () => {
    const { a, seen } = app({ rows: [{
      tool: 'claude-code', machine: 'm', os: 'darwin', scanner_version: '1',
      last_reported_at: NOW, last_event_ts: null, reason: 'ok'
    }] });
    const { body } = await get(a);
    assert.doesNotMatch(JSON.stringify(body), /api_key|password/i);
    for (const { sql } of seen) {
      assert.doesNotMatch(sql, /\busers\b/i, 'this endpoint has no business joining users');
    }
  });

  it('500s without leaking the database error', async () => {
    const a = express();
    a.use('/api/usage/self-check', createSelfCheckRouter({
      query: async () => { throw new Error('connection to 10.0.0.5:5432 refused'); },
      auth: (req, _res, next) => { req.user = { id: 7 }; next(); },
      now: () => NOW
    }));
    const { status, body } = await get(a);
    assert.equal(status, 500);
    assert.doesNotMatch(JSON.stringify(body), /10\.0\.0\.5/);
  });
});
