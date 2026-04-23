import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { createBroadcastRouter, validateBroadcastPayload } =
  await import('../src/routes/broadcast.js');
const { filterVisibleBroadcasts, filterInjectable } =
  await import('../src/lib/broadcast-filter.js');
const { ensureUpgradeReminder } =
  await import('../src/jobs/nightly-upgrade-reminder.js');

// ============================================================
// Test app helpers
// ============================================================
function buildApp({ queryFn, user, deps = {} }) {
  const fakeAuth = (req, res, next) => {
    if (!user) return res.status(401).json({ error: 'no auth' });
    req.user = user; next();
  };
  const fakeAdminAuth = (req, res, next) => {
    if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
      return res.status(403).json({ error: '需要管理員權限' });
    }
    req.user = user; next();
  };
  const fakeSuperAuth = (req, res, next) => {
    if (!user || user.role !== 'super_admin') {
      return res.status(403).json({ error: '需要 super_admin' });
    }
    req.user = user; next();
  };
  const router = createBroadcastRouter({
    query: queryFn,
    auth: fakeAuth,
    adminAuth: fakeAdminAuth,
    superAdminAuth: fakeSuperAuth,
    ...deps
  });
  const app = express();
  app.use(express.json());
  app.use('/api/broadcast', router);
  return app;
}

async function request(app, { method = 'GET', path, body }) {
  return await new Promise((resolve, reject) => {
    const req = { method, url: path, path, headers: {}, query: {}, body: body || {} };
    // parse query string
    const qIdx = path.indexOf('?');
    if (qIdx !== -1) {
      const qs = path.slice(qIdx + 1);
      req.path = path.slice(0, qIdx);
      for (const pair of qs.split('&')) {
        const [k, v] = pair.split('=');
        req.query[decodeURIComponent(k)] = decodeURIComponent(v || '');
      }
    }
    const res = {
      statusCode: 200, _headers: {},
      setHeader(k, v) { this._headers[k] = v; }, getHeader(k) { return this._headers[k]; },
      status(c) { this.statusCode = c; return this; },
      json(p) { resolve({ status: this.statusCode, body: p }); },
      send(p) { resolve({ status: this.statusCode, body: p }); },
      end() { resolve({ status: this.statusCode, body: null }); }
    };
    try { app.handle(req, res, (err) => err ? reject(err) : resolve({ status: res.statusCode })); }
    catch (e) { reject(e); }
  });
}

// ============================================================
// validateBroadcastPayload
// ============================================================
describe('validateBroadcastPayload', () => {
  it('accepts valid payload', () => {
    assert.equal(validateBroadcastPayload({
      type: 'announcement', title: 'hi', body: 'world'
    }), null);
  });

  it('rejects invalid type', () => {
    const err = validateBroadcastPayload({ type: 'wat', title: 'a', body: 'b' });
    assert.match(err, /type/);
  });

  it('rejects missing title / body', () => {
    assert.ok(validateBroadcastPayload({ type: 'announcement', body: 'b' }));
    assert.ok(validateBroadcastPayload({ type: 'announcement', title: 'a' }));
  });

  it('rejects body exceeding 2000 chars', () => {
    const big = 'x'.repeat(2001);
    assert.match(validateBroadcastPayload({ type: 'announcement', title: 't', body: big }), /2000/);
  });

  it('rejects non-array target_users', () => {
    assert.match(validateBroadcastPayload({
      type: 'announcement', title: 't', body: 'b', target_users: 'nope'
    }), /target_users/);
  });

  it('rejects target_users with invalid id', () => {
    assert.match(validateBroadcastPayload({
      type: 'announcement', title: 't', body: 'b', target_users: [1, -5]
    }), /target_users/);
  });

  // ----- Fix M3 / M4: date validation + Number coerce -----
  it('accepts numeric string for snooze_hours (coerce)', () => {
    assert.equal(validateBroadcastPayload({
      type: 'announcement', title: 't', body: 'b', snooze_hours: '24'
    }), null);
  });

  it('rejects negative / zero snooze_hours (after coerce)', () => {
    assert.match(validateBroadcastPayload({
      type: 'announcement', title: 't', body: 'b', snooze_hours: '-1'
    }), /snooze_hours/);
  });

  it('rejects invalid starts_at', () => {
    assert.match(validateBroadcastPayload({
      type: 'announcement', title: 't', body: 'b', starts_at: 'not-a-date'
    }), /starts_at/);
  });

  it('rejects invalid ends_at', () => {
    assert.match(validateBroadcastPayload({
      type: 'announcement', title: 't', body: 'b', ends_at: 'garbage'
    }), /ends_at/);
  });

  it('rejects ends_at ≤ starts_at', () => {
    assert.match(validateBroadcastPayload({
      type: 'announcement', title: 't', body: 'b',
      starts_at: '2026-05-01T00:00:00Z',
      ends_at: '2026-04-30T00:00:00Z'
    }), /晚於/);
  });

  it('accepts valid ISO dates', () => {
    assert.equal(validateBroadcastPayload({
      type: 'announcement', title: 't', body: 'b',
      starts_at: '2026-05-01T00:00:00Z',
      ends_at: '2026-05-02T00:00:00Z'
    }), null);
  });
});

// ============================================================
// POST /api/broadcast/admin — create
// ============================================================
describe('POST /api/broadcast/admin', () => {
  it('rejects non-super_admin', async () => {
    const app = buildApp({ queryFn: async () => ({ rows: [] }), user: { id: 2, role: 'admin' } });
    const res = await request(app, {
      method: 'POST',
      path: '/api/broadcast/admin',
      body: { type: 'announcement', title: 'x', body: 'y' }
    });
    assert.equal(res.status, 403);
  });

  it('super_admin inserts and returns created row', async () => {
    let captured = null;
    const query = async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ id: 42, type: 'announcement', title: 'x', body: 'y', is_auto: false }] };
    };
    const app = buildApp({ queryFn: query, user: { id: 1, role: 'super_admin' } });
    const res = await request(app, {
      method: 'POST',
      path: '/api/broadcast/admin',
      body: { type: 'announcement', title: 'x', body: 'y', severity: 'warning' }
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.id, 42);
    assert.match(captured.sql, /INSERT INTO broadcast_messages/);
    assert.equal(captured.params[1], 'warning', 'severity passed');
  });

  it('rejects invalid body', async () => {
    const app = buildApp({ queryFn: async () => ({ rows: [] }), user: { id: 1, role: 'super_admin' } });
    const res = await request(app, {
      method: 'POST',
      path: '/api/broadcast/admin',
      body: { type: 'invalid-type', title: 't', body: 'b' }
    });
    assert.equal(res.status, 400);
  });
});

// ============================================================
// GET /api/broadcast/admin — list
// ============================================================
describe('GET /api/broadcast/admin', () => {
  it('rejects non-admin', async () => {
    const app = buildApp({ queryFn: async () => ({ rows: [] }), user: { id: 5, role: 'user' } });
    const res = await request(app, { path: '/api/broadcast/admin' });
    assert.equal(res.status, 403);
  });

  it('admin lists only active by default', async () => {
    let captured = null;
    const app = buildApp({
      queryFn: async (sql) => { captured = sql; return { rows: [{ id: 1 }] }; },
      user: { id: 2, role: 'admin' }
    });
    const res = await request(app, { path: '/api/broadcast/admin' });
    assert.equal(res.status, 200);
    assert.match(captured, /ends_at IS NULL OR ends_at > NOW/);
  });

  it('?include_ended=true loads all history', async () => {
    let captured = null;
    const app = buildApp({
      queryFn: async (sql) => { captured = sql; return { rows: [] }; },
      user: { id: 2, role: 'admin' }
    });
    const res = await request(app, { path: '/api/broadcast/admin?include_ended=true' });
    assert.equal(res.status, 200);
    assert.doesNotMatch(captured, /ends_at IS NULL/);
  });
});

// ============================================================
// DELETE /api/broadcast/admin/:id — revoke
// ============================================================
describe('DELETE /api/broadcast/admin/:id', () => {
  it('sets ends_at=NOW() for super_admin', async () => {
    let captured = null;
    const app = buildApp({
      queryFn: async (sql, params) => {
        captured = { sql, params };
        return { rowCount: 1, rows: [{ id: 7 }] };
      },
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, { method: 'DELETE', path: '/api/broadcast/admin/7' });
    assert.equal(res.status, 200);
    assert.match(captured.sql, /UPDATE broadcast_messages SET ends_at = NOW/);
  });

  it('404 if not found', async () => {
    const app = buildApp({
      queryFn: async () => ({ rowCount: 0, rows: [] }),
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, { method: 'DELETE', path: '/api/broadcast/admin/999' });
    assert.equal(res.status, 404);
  });

  // ----- Fix M2: auto-managed broadcast cannot be revoked -----
  it('rejects revoking is_auto=TRUE broadcast', async () => {
    const app = buildApp({
      queryFn: async (sql) => {
        if (/SELECT is_auto/.test(sql)) return { rowCount: 1, rows: [{ is_auto: true }] };
        throw new Error('should not reach UPDATE');
      },
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, { method: 'DELETE', path: '/api/broadcast/admin/7' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /auto-managed/);
  });
});

// ============================================================
// PATCH /api/broadcast/admin/:id — update
// ============================================================
describe('PATCH /api/broadcast/admin/:id', () => {
  it('rejects invalid ends_at', async () => {
    const app = buildApp({
      queryFn: async () => ({ rows: [] }),
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, {
      method: 'PATCH', path: '/api/broadcast/admin/7',
      body: { ends_at: 'not-a-date' }
    });
    assert.equal(res.status, 400);
  });

  it('allows ends_at=null to clear', async () => {
    let captured = null;
    const app = buildApp({
      queryFn: async (sql, params) => {
        captured = params;
        return { rowCount: 1, rows: [{ id: 7, ends_at: null, target_users: null }] };
      },
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, {
      method: 'PATCH', path: '/api/broadcast/admin/7',
      body: { ends_at: null }
    });
    assert.equal(res.status, 200);
    assert.equal(captured[0], null);
  });

  it('validates target_users integer array', async () => {
    const app = buildApp({
      queryFn: async () => ({ rows: [] }),
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, {
      method: 'PATCH', path: '/api/broadcast/admin/7',
      body: { target_users: [1, 'nope'] }
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid id', async () => {
    const app = buildApp({
      queryFn: async () => ({ rows: [] }),
      user: { id: 1, role: 'super_admin' }
    });
    const res = await request(app, {
      method: 'PATCH', path: '/api/broadcast/admin/abc',
      body: { ends_at: null }
    });
    assert.equal(res.status, 400);
  });
});

// ============================================================
// POST /api/broadcast/dismiss — snooze / dismiss（已改走 filterVisibleBroadcasts）
// ============================================================
describe('POST /api/broadcast/dismiss', () => {
  // Mock filterVisibleBroadcasts output via DB
  function dismissQuery(visibleBroadcasts) {
    return async (sql, params) => {
      // filterVisibleBroadcasts 內部 query（SELECT b.*, s.dismissed_at FROM broadcast_messages ... LEFT JOIN user_broadcast_state）
      if (/FROM broadcast_messages b/i.test(sql) && /LEFT JOIN user_broadcast_state/i.test(sql)) {
        return { rows: visibleBroadcasts };
      }
      if (/INSERT INTO user_broadcast_state/.test(sql)) return { rows: [] };
      return { rows: [] };
    };
  }

  it('rejects dismiss on broadcast NOT in user visibility (Critical fix)', async () => {
    // User 嘗試 dismiss 一個他看不到的 broadcast_id
    const app = buildApp({
      queryFn: dismissQuery([]), // filterVisibleBroadcasts 回傳空
      user: { id: 5, role: 'user' }
    });
    const res = await request(app, {
      method: 'POST', path: '/api/broadcast/dismiss',
      body: { broadcast_id: 999, tool: 'claude-code' }
    });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /可見/);
  });

  it('rejects snooze on broadcast with allow_snooze=false', async () => {
    const app = buildApp({
      queryFn: dismissQuery([{ id: 9, allow_snooze: false, snooze_hours: 24 }]),
      user: { id: 5, role: 'user' }
    });
    const res = await request(app, {
      method: 'POST',
      path: '/api/broadcast/dismiss',
      body: { broadcast_id: 9, tool: 'claude-code', snooze_hours: 24 }
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /snooze/);
  });

  it('allows snooze when allow_snooze=true', async () => {
    const nowDate = new Date('2026-04-22T12:00:00Z');
    const app = buildApp({
      queryFn: dismissQuery([{ id: 9, allow_snooze: true, snooze_hours: 24 }]),
      user: { id: 5, role: 'user' },
      deps: { now: () => nowDate }
    });
    const res = await request(app, {
      method: 'POST',
      path: '/api/broadcast/dismiss',
      body: { broadcast_id: 9, tool: 'claude-code', snooze_hours: 24 }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.dismissed, false);
    assert.ok(res.body.snooze_until);
    const diff = new Date(res.body.snooze_until).getTime() - nowDate.getTime();
    assert.equal(Math.round(diff / 3_600_000), 24);
  });

  it('accepts snooze_hours as string (Number coerce)', async () => {
    const nowDate = new Date('2026-04-22T12:00:00Z');
    const app = buildApp({
      queryFn: dismissQuery([{ id: 9, allow_snooze: true, snooze_hours: 24 }]),
      user: { id: 5, role: 'user' },
      deps: { now: () => nowDate }
    });
    const res = await request(app, {
      method: 'POST',
      path: '/api/broadcast/dismiss',
      body: { broadcast_id: 9, tool: 'claude-code', snooze_hours: '12' }
    });
    assert.equal(res.status, 200);
    const diff = new Date(res.body.snooze_until).getTime() - nowDate.getTime();
    assert.equal(Math.round(diff / 3_600_000), 12);
  });

  it('dismisses (no snooze) when snooze_hours not provided', async () => {
    const app = buildApp({
      queryFn: dismissQuery([{ id: 9, allow_snooze: false }]),
      user: { id: 5, role: 'user' }
    });
    const res = await request(app, {
      method: 'POST',
      path: '/api/broadcast/dismiss',
      body: { broadcast_id: 9, tool: 'claude-code' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.dismissed, true);
    assert.equal(res.body.snooze_until, null);
  });
});

// ============================================================
// GET /api/broadcast/active — user 可見廣播
// ============================================================
describe('GET /api/broadcast/active', () => {
  it('requires tool parameter', async () => {
    const app = buildApp({
      queryFn: async () => ({ rows: [] }),
      user: { id: 5, role: 'user' }
    });
    const res = await request(app, { path: '/api/broadcast/active' });
    assert.equal(res.status, 400);
  });

  it('returns visible broadcasts for authenticated user', async () => {
    const app = buildApp({
      queryFn: async () => ({ rows: [
        { id: 1, title: 'A', min_version: null, max_version: null },
        { id: 2, title: 'B', min_version: null, max_version: null }
      ]}),
      user: { id: 5, role: 'user' }
    });
    const res = await request(app, { path: '/api/broadcast/active?tool=claude-code' });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);
  });

  it('unauthenticated = 401', async () => {
    const app = buildApp({ queryFn: async () => ({ rows: [] }), user: null });
    const res = await request(app, { path: '/api/broadcast/active?tool=claude-code' });
    assert.equal(res.status, 401);
  });
});

// ============================================================
// filterVisibleBroadcasts
// ============================================================
describe('filterVisibleBroadcasts', () => {
  const now = new Date('2026-04-22T12:00:00Z');

  it('returns empty for missing user_id / tool', async () => {
    const r1 = await filterVisibleBroadcasts(async () => ({ rows: [] }), { user_id: 0, tool: 'x' });
    assert.deepEqual(r1, []);
    const r2 = await filterVisibleBroadcasts(async () => ({ rows: [] }), { user_id: 1, tool: '' });
    assert.deepEqual(r2, []);
  });

  it('filters by min_version in JS (client too old)', async () => {
    const rows = [
      { id: 1, min_version: '1.17.0', max_version: null },
      { id: 2, min_version: null, max_version: null }
    ];
    const result = await filterVisibleBroadcasts(async () => ({ rows }), {
      user_id: 1, tool: 'claude-code', client_version: '1.16.0', now
    });
    assert.deepEqual(result.map(r => r.id), [2], 'client 1.16 < min_version 1.17 should be filtered');
  });

  it('filters by max_version (client too new)', async () => {
    const rows = [
      { id: 1, min_version: null, max_version: '1.16.5' },
      { id: 2, min_version: null, max_version: null }
    ];
    const result = await filterVisibleBroadcasts(async () => ({ rows }), {
      user_id: 1, tool: 'claude-code', client_version: '1.17.0', now
    });
    assert.deepEqual(result.map(r => r.id), [2], 'client 1.17 > max_version 1.16.5 should be filtered');
  });

  it('passes through when client_version is null (no version check)', async () => {
    const rows = [{ id: 1, min_version: '1.17.0', max_version: '1.16.0' }];
    const result = await filterVisibleBroadcasts(async () => ({ rows }), {
      user_id: 1, tool: 'claude-code', now
    });
    assert.equal(result.length, 1);
  });
});

// ============================================================
// filterInjectable — cooldown
// ============================================================
describe('filterInjectable (cooldown)', () => {
  const now = new Date('2026-04-22T12:00:00Z');

  it('forceInject=true bypasses cooldown', () => {
    const broadcasts = [{ id: 1, last_injected_at: new Date('2026-04-22T11:59:00Z'), cooldown_minutes: 30 }];
    const result = filterInjectable(broadcasts, { forceInject: true, now });
    assert.equal(result.length, 1);
  });

  it('rejects items still in cooldown', () => {
    const broadcasts = [
      { id: 1, last_injected_at: new Date('2026-04-22T11:50:00Z'), cooldown_minutes: 30 }, // 10 min ago
      { id: 2, last_injected_at: new Date('2026-04-22T11:00:00Z'), cooldown_minutes: 30 }  // 60 min ago
    ];
    const result = filterInjectable(broadcasts, { forceInject: false, now });
    assert.deepEqual(result.map(r => r.id), [2]);
  });

  it('never-injected broadcasts pass through', () => {
    const broadcasts = [{ id: 1, last_injected_at: null, cooldown_minutes: 30 }];
    const result = filterInjectable(broadcasts, { forceInject: false, now });
    assert.equal(result.length, 1);
  });

  it('default cooldown_minutes=1440 when undefined', () => {
    const broadcasts = [{ id: 1, last_injected_at: new Date('2026-04-22T11:00:00Z') }];
    const result = filterInjectable(broadcasts, { forceInject: false, now });
    // 60 min < 1440 default → blocked
    assert.equal(result.length, 0);
  });
});

// ============================================================
// ensureUpgradeReminder (nightly job)
// ============================================================
// ============================================================
// POST /api/broadcast/inject — MCP 注入 endpoint (P4)
// ============================================================
describe('POST /api/broadcast/inject', () => {
  function mkAdminQuery({ seenRow = null, visibleRows = [], upsertCaptures = [] } = {}) {
    return async (sql, params) => {
      if (/SELECT last_mcp_call_at.*FROM user_tool_last_seen/s.test(sql)) {
        return { rows: seenRow ? [seenRow] : [] };
      }
      if (/INSERT INTO user_tool_last_seen/.test(sql)) {
        upsertCaptures.push({ type: 'utls', params });
        return { rows: [] };
      }
      if (/FROM broadcast_messages b/i.test(sql) && /LEFT JOIN user_broadcast_state/i.test(sql)) {
        return { rows: visibleRows };
      }
      if (/INSERT INTO user_broadcast_state/.test(sql) && /last_injected_at/.test(sql)) {
        upsertCaptures.push({ type: 'inject_mark', params });
        return { rows: [] };
      }
      return { rows: [] };
    };
  }

  it('rejects missing tool', async () => {
    const app = buildApp({
      queryFn: mkAdminQuery(),
      user: { id: 5, role: 'user' }
    });
    const res = await request(app, { method: 'POST', path: '/api/broadcast/inject', body: {} });
    assert.equal(res.status, 400);
  });

  it('first-of-day forceInject bypasses cooldown', async () => {
    // Previous seen was yesterday
    const yesterday = new Date('2026-04-21T08:00:00Z');
    const nowDate = new Date('2026-04-22T10:00:00+08:00');
    const captures = [];
    const visibleRows = [
      { id: 1, title: 't', body: 'b', severity: 'warning',
        cta_text: null, cta_action: null,
        allow_snooze: false, snooze_hours: 24,
        cooldown_minutes: 30,
        last_injected_at: new Date(nowDate.getTime() - 5 * 60000) // 5 min ago, normally cooldown blocks
      }
    ];
    const app = buildApp({
      queryFn: mkAdminQuery({
        seenRow: { last_mcp_call_at: yesterday, last_day_seen_tpe: '2026-04-21' },
        visibleRows,
        upsertCaptures: captures
      }),
      user: { id: 5, role: 'user' },
      deps: { now: () => nowDate }
    });
    const res = await request(app, {
      method: 'POST', path: '/api/broadcast/inject',
      body: { tool: 'claude-code' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.force, true, 'first-of-day should forceInject');
    assert.equal(res.body.broadcasts.length, 1);
  });

  it('4h gap triggers forceInject', async () => {
    const nowDate = new Date('2026-04-22T14:00:00+08:00');
    const fourAndHalfHoursAgo = new Date(nowDate.getTime() - 4.5 * 3600 * 1000);
    const visibleRows = [
      { id: 1, title: 't', body: 'b', severity: 'info',
        cta_text: null, allow_snooze: false, cooldown_minutes: 60,
        last_injected_at: new Date(nowDate.getTime() - 10 * 60000)  // 10min ago
      }
    ];
    const app = buildApp({
      queryFn: mkAdminQuery({
        seenRow: {
          last_mcp_call_at: fourAndHalfHoursAgo,
          last_day_seen_tpe: new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
          }).format(nowDate)
        },
        visibleRows
      }),
      user: { id: 5, role: 'user' },
      deps: { now: () => nowDate }
    });
    const res = await request(app, {
      method: 'POST', path: '/api/broadcast/inject',
      body: { tool: 'claude-code' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.force, true);
    assert.equal(res.body.broadcasts.length, 1);
  });

  it('no force + cooldown active → not injected', async () => {
    const nowDate = new Date('2026-04-22T14:00:00+08:00');
    const tenMinAgo = new Date(nowDate.getTime() - 10 * 60000);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(nowDate);
    const visibleRows = [
      { id: 1, title: 't', body: 'b', severity: 'info',
        cta_text: null, allow_snooze: false, cooldown_minutes: 60,
        last_injected_at: tenMinAgo
      }
    ];
    const app = buildApp({
      queryFn: mkAdminQuery({
        seenRow: { last_mcp_call_at: tenMinAgo, last_day_seen_tpe: today },
        visibleRows
      }),
      user: { id: 5, role: 'user' },
      deps: { now: () => nowDate }
    });
    const res = await request(app, {
      method: 'POST', path: '/api/broadcast/inject',
      body: { tool: 'claude-code' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.force, false);
    assert.equal(res.body.broadcasts.length, 0, '10min < 60min cooldown → skip');
  });

  it('unauthenticated = 401', async () => {
    const app = buildApp({ queryFn: mkAdminQuery(), user: null });
    const res = await request(app, {
      method: 'POST', path: '/api/broadcast/inject',
      body: { tool: 'claude-code' }
    });
    assert.equal(res.status, 401);
  });
});

describe('ensureUpgradeReminder', () => {
  it('skips when no super_admin exists', async () => {
    const query = async (sql) => {
      if (/role = 'super_admin'/.test(sql)) return { rowCount: 0, rows: [] };
      return { rows: [] };
    };
    const result = await ensureUpgradeReminder({ query });
    assert.equal(result.inserted, false);
    assert.equal(result.reason, 'no_super_admin');
  });

  it('inserts when no existing reminder for this version', async () => {
    const calls = [];
    const query = async (sql, params) => {
      calls.push({ sql, params });
      if (/role = 'super_admin'/.test(sql)) return { rowCount: 1, rows: [{ id: 1 }] };
      if (/SELECT id FROM broadcast_messages/.test(sql)) return { rowCount: 0, rows: [] };
      if (/INSERT INTO broadcast_messages/.test(sql)) return { rowCount: 1, rows: [{ id: 88 }] };
      return { rows: [] };
    };
    const result = await ensureUpgradeReminder({ query, serverVersion: '1.17.0' });
    assert.equal(result.inserted, true);
    assert.equal(result.broadcast_id, 88);
    assert.equal(result.max_version, '1.17.0-prev');
  });

  it('skips insert when already exists (idempotent)', async () => {
    const query = async (sql) => {
      if (/role = 'super_admin'/.test(sql)) return { rowCount: 1, rows: [{ id: 1 }] };
      if (/SELECT id FROM broadcast_messages/.test(sql)) return { rowCount: 1, rows: [{ id: 99 }] };
      throw new Error('should not reach INSERT');
    };
    const result = await ensureUpgradeReminder({ query, serverVersion: '1.17.0' });
    assert.equal(result.inserted, false);
    assert.equal(result.reason, 'already_exists');
    assert.equal(result.broadcast_id, 99);
  });

  it('rebuilds when existing reminder was revoked (ends_at in past)', async () => {
    // Fix M2: job 只看 active（ends_at IS NULL OR > NOW()）reminders
    // 之前被撤銷的 (ends_at 已過) → 不算 existing → 允許重建
    const calls = [];
    const query = async (sql, params) => {
      calls.push({ sql, params });
      if (/role = 'super_admin'/.test(sql)) return { rowCount: 1, rows: [{ id: 1 }] };
      // SELECT 只匹配 active，這裡回傳 empty
      if (/SELECT id FROM broadcast_messages/.test(sql)) {
        assert.match(sql, /ends_at IS NULL OR ends_at > NOW/);
        return { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO broadcast_messages/.test(sql)) return { rowCount: 1, rows: [{ id: 100 }] };
      return { rows: [] };
    };
    const result = await ensureUpgradeReminder({ query, serverVersion: '1.17.0' });
    assert.equal(result.inserted, true);
    assert.equal(result.broadcast_id, 100);
  });

  it('handles SQLSTATE 23505 race (concurrent cron fires)', async () => {
    // Fix M1: 用 err.code 而非 err.message 字串匹配
    const query = async (sql) => {
      if (/role = 'super_admin'/.test(sql)) return { rowCount: 1, rows: [{ id: 1 }] };
      if (/SELECT id FROM broadcast_messages/.test(sql)) return { rowCount: 0, rows: [] };
      if (/INSERT INTO broadcast_messages/.test(sql)) {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        err.constraint = 'ux_broadcast_auto_upgrade';
        throw err;
      }
      return { rows: [] };
    };
    const result = await ensureUpgradeReminder({ query, serverVersion: '1.17.0' });
    assert.equal(result.inserted, false);
    assert.equal(result.reason, 'already_exists_race');
  });
});
