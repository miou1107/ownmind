// v1.26.74 — 最近活動 means the last thing the person did, not the last thing that was
// logged about them.
//
// Raised by Vin from production on 2026-08-06: he was working in Claude at the time and
// the column read 00:20, eight hours earlier. The number was right and the meaning was
// wrong. `last_active_at` was `MAX(session_logs.created_at)`, and a session_log is only
// written when the AI calls `ownmind_log_session` — which its own description says
// happens "before a conversation ends". One long working session therefore shows the time
// it started and does not move again until it finishes.
//
// He chose to fix the data rather than rename the column, and the reason holds: renaming
// it to 最近記錄 would be accurate and would still leave nobody able to see who is working
// right now.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startServer } from './helpers/app-server.js';

const { createTeamOverviewRouter } = await import('../src/routes/usage/team-overview.js');

const FROM = '2026-08-05T00:00:00.000+08:00';
const TO = '2026-08-06T23:59:59.999+08:00';

function run({ rows = [], onQuery = null } = {}) {
  const seen = [];
  const query = async (sql, params) => {
    seen.push({ sql, params });
    onQuery?.(sql, params);
    return { rows };
  };
  const app = express();
  app.use('/api/usage/admin/team-overview', createTeamOverviewRouter({
    query, adminAuth: (req, _res, next) => { req.user = { id: 1, role: 'admin' }; next(); }
  }));
  return { app, seen };
}

async function get(app, qs = `?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`) {
  // v1.26.158 — through the shared helper, which draws again when the OS hands back a port
  // `fetch` refuses to dial. This file failed on 2026-08-12 as `bad port`, which is the
  // v1.26.143 finding arriving in a file that had never been migrated.
  const server = await startServer(app);
  try {
    const res = await fetch(`${server.url}/api/usage/admin/team-overview${qs}`);
    return { status: res.status, body: await res.json() };
  } finally {
    await server.close();
  }
}

describe('what 最近活動 is measured from', () => {
  it('takes the newest of session logs, MCP activity and token events', async () => {
    // Three sources, three different delays. A session log only lands when a conversation
    // ends. MCP activity lands when the AI calls an ownmind tool, which a long coding
    // session may never do. Token events land on the scanner's schedule and are the only
    // one that moves while somebody is in the middle of working.
    const { app, seen } = run();
    await get(app);
    const sql = seen[0].sql;
    assert.match(sql, /GREATEST/i, 'the newest of several sources, not one of them');
    assert.match(sql, /activity_logs/i);
    assert.match(sql, /token_events/i);
    assert.match(sql, /session_logs/i);
  });

  it('bounds every source by the same window', async () => {
    // A source read without the window would let a member outside the period drag the
    // whole row's timestamp forward, and the page would disagree with its own date picker.
    const { app, seen } = run();
    await get(app);
    const sql = seen[0].sql;
    const windows = sql.match(/>=\s*\$1/g) ?? [];
    assert.ok(windows.length >= 3,
      `each of the three sources must be bounded by the window; found ${windows.length}`);
    assert.equal(seen[0].params.length, 2);
  });

  it('orders the list by that same value, not by the session log alone', async () => {
    // The column and the sort order have to agree, or the top row is not the most recent.
    // Sorting by the output name rather than repeating the expression makes them the same
    // value by construction — repeating it would also evaluate both subqueries twice.
    const { app, seen } = run();
    await get(app);
    const order = seen[0].sql.slice(seen[0].sql.search(/ORDER BY/i));
    assert.match(order, /last_active_at/i,
      'ordering by MAX(session_logs) while displaying something else puts the rows in the wrong order');
  });

  it('reads the extra sources once per person, not once per work log', async () => {
    // A LEFT JOIN LATERAL sits after JOIN session_logs, so it is evaluated for every
    // work-log row that survives the window: somebody with 50 sessions in the period costs
    // 50 MAX(ts) lookups per source instead of one, against token_events, the largest
    // table in the product. A scalar subquery in the SELECT of a grouped query is computed
    // once per output group. Found by adversarial review of this change, 2026-08-06.
    const { app, seen } = run();
    await get(app);
    const sql = seen[0].sql;
    assert.doesNotMatch(sql, /LATERAL/i,
      'a lateral join here re-runs per session_logs row, not per person');
    assert.match(sql, /\(\s*SELECT\s+MAX\(\s*a\.ts\s*\)\s+FROM\s+activity_logs/i);
    assert.match(sql, /\(\s*SELECT\s+MAX\(\s*e\.ts\s*\)\s+FROM\s+token_events/i);
    assert.doesNotMatch(sql.slice(sql.search(/GROUP BY/i), sql.search(/ORDER BY/i)),
      /last_ts/i, 'nothing from the extra sources needs to be grouped by any more');
  });

  it('still decides who appears from the session logs', async () => {
    // Deliberately unchanged. Membership of this list is a separate question from what the
    // timestamp means, and widening it would quietly change who the page is about.
    const { app, seen } = run();
    await get(app);
    assert.match(seen[0].sql, /JOIN\s+session_logs/i);
  });
});

describe('the response', () => {
  it('passes the computed value through as last_active_at', async () => {
    const { app } = run({ rows: [{
      user_id: 1, user_name: 'Vin',
      last_active_at: new Date('2026-08-06T08:20:00.000Z'),
      session_count: 3, sessions_json: []
    }] });
    const { status, body } = await get(app);
    assert.equal(status, 200);
    assert.equal(body.members[0].last_active_at.toISOString?.() ?? body.members[0].last_active_at,
      new Date('2026-08-06T08:20:00.000Z').toISOString());
  });

  it('still rejects a bad date range rather than querying', async () => {
    const { app, seen } = run();
    const { status } = await get(app, '?from=not-a-date&to=also-not');
    assert.equal(status, 400);
    assert.equal(seen.length, 0);
  });
});

// ────────────────────────────────────────────────────────────
// The other page that answers the same question
// ────────────────────────────────────────────────────────────

describe('統計儀表板 must not disagree with 團隊用量', () => {
  it('reads last_active from the same three sources', async () => {
    // Two pages answering "when was this person last active" with different numbers is
    // its own defect — backlog item 7 is exactly that shape. This one used to be
    // MAX(activity_logs.ts) alone, which a long coding session never moves.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const src = fs.readFileSync(path.join(repoRoot, 'src/routes/activity.js'), 'utf8');
    const stmt = src.slice(src.indexOf('as last_active') - 800, src.indexOf('as last_active'));
    assert.match(stmt, /GREATEST/i);
    assert.match(stmt, /activity_logs/i);
    assert.match(stmt, /token_events/i);
    assert.match(stmt, /session_logs/i);
  });
});
