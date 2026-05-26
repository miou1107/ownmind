/**
 * v1.19.8 — Setup Wizard unit tests
 *
 * Tracks openspec/changes/v1.19.8-setup-wizard/spec.md
 *   scenarios 4 ~ 10, 14 (route layer).
 *
 * Style mirrors tests/admin-work-log.test.js: inject fake query / withTransaction.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createSetupRouter, createFirstRunDetector } from '../src/routes/setup.js';

/**
 * Build a fake DB client; simulates pg_advisory_xact_lock and the basic SQL operations.
 */
function makeFakeDb({ initialUsers = [], onInsertUser = null, throwAuditError = false } = {}) {
  let users = [...initialUsers];
  const queries = [];

  async function fakeQuery(text, params) {
    queries.push({ text, params });
    if (/SELECT COUNT\(\*\).*FROM users/i.test(text)) {
      const adminCount = users.filter((u) => u.role === 'admin' || u.role === 'super_admin').length;
      return { rows: [{ n: adminCount }] };
    }
    if (/pg_advisory_xact_lock/i.test(text)) {
      return { rows: [] };
    }
    if (/INSERT INTO users/i.test(text)) {
      if (onInsertUser) onInsertUser(params);
      const [name, email, apiKey, passwordHash] = params;
      // Simulate unique violation.
      if (users.find((u) => u.email === email)) {
        const e = new Error('duplicate key value violates unique constraint');
        e.code = '23505';
        throw e;
      }
      const newUser = {
        id: 'user-' + (users.length + 1),
        name,
        email,
        role: 'super_admin',
        api_key: apiKey,
        password_hash: passwordHash,
        created_at: new Date().toISOString(),
      };
      users.push(newUser);
      return { rows: [{ ...newUser, password_hash: undefined }] };
    }
    if (/INSERT INTO audit_logs/i.test(text)) {
      if (throwAuditError) throw new Error('audit_log table broken');
      return { rows: [] };
    }
    return { rows: [] };
  }

  async function withTransaction(fn) {
    const client = { query: fakeQuery };
    return await fn(client);
  }

  return { fakeQuery, withTransaction, getUsers: () => [...users], getQueries: () => queries };
}

function buildApp(deps) {
  const router = createSetupRouter(deps);
  const app = express();
  app.use(express.json());
  app.use('/api/setup', router);
  return app;
}

async function request(app, { method, path, body }) {
  return await new Promise((resolve) => {
    const req = {
      method,
      url: path,
      path,
      headers: { 'content-type': 'application/json' },
      body: body || {},
    };
    const res = {
      statusCode: 200,
      _body: null,
      setHeader() {},
      getHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(b) { this._body = b; resolve({ status: this.statusCode, body: b }); return this; },
      send(b) { this._body = b; resolve({ status: this.statusCode, body: b }); return this; },
      end(b) { this._body = b; resolve({ status: this.statusCode, body: b }); return this; },
    };
    app(req, res, (err) => err && resolve({ status: 500, body: { error: err.message } }));
  });
}

// ============================================================
// Scenario 4: GET /status reports first_run
// ============================================================

describe('v1.19.8 scenario 4 — GET /api/setup/status', () => {
  it('empty users table → first_run=true, users_count=0', async () => {
    const db = makeFakeDb({ initialUsers: [] });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });
    const r = await request(app, { method: 'GET', path: '/api/setup/status' });
    assert.equal(r.status, 200);
    assert.equal(r.body.first_run, true);
    assert.equal(r.body.users_count, 0);
  });

  it('users table already has a super_admin → first_run=false', async () => {
    const db = makeFakeDb({
      initialUsers: [{ id: 'u1', email: 'a@b.com', role: 'super_admin' }],
    });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });
    const r = await request(app, { method: 'GET', path: '/api/setup/status' });
    assert.equal(r.body.first_run, false);
    assert.equal(r.body.users_count, 1);
  });

  it('scenario 14: super_admin exists but password_hash IS NULL → still first_run=false', async () => {
    // first_run is decided by role, not password_hash, so the legacy SETUP_TOKEN flow's
    // "pending password" accounts do not falsely re-trigger the wizard.
    const db = makeFakeDb({
      initialUsers: [{ id: 'u1', email: 'pending@b.com', role: 'super_admin', password_hash: null }],
    });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });
    const r = await request(app, { method: 'GET', path: '/api/setup/status' });
    assert.equal(r.body.first_run, false);
  });
});

// ============================================================
// Scenario 5: POST /init successfully creates the first super_admin
// ============================================================

describe('v1.19.8 scenario 5 — POST /api/setup/init success path', () => {
  it('first_run + correct input → creates super_admin, returns api_key', async () => {
    const db = makeFakeDb({ initialUsers: [] });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });

    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'admin@example.com', password: 'secure123', name: 'Vin' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.email, 'admin@example.com');
    assert.equal(r.body.role, 'super_admin');
    assert.equal(r.body.name, 'Vin');
    assert.ok(r.body.api_key, 'should return api_key');
    // Must not leak the password hash.
    assert.equal(r.body.password_hash, undefined);
  });

  it('successful creation calls advisory lock (race-condition guard)', async () => {
    const db = makeFakeDb({ initialUsers: [] });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });
    await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'a@b.com', password: 'secure123' },
    });
    const queries = db.getQueries();
    const hasAdvisoryLock = queries.some((q) => /pg_advisory_xact_lock/i.test(q.text));
    assert.equal(hasAdvisoryLock, true, 'should call pg_advisory_xact_lock');
  });

  it('successful creation writes audit_log (action=setup_init)', async () => {
    const db = makeFakeDb({ initialUsers: [] });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });
    await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'a@b.com', password: 'secure123' },
    });
    const queries = db.getQueries();
    const auditCall = queries.find((q) => /INSERT INTO audit_logs/i.test(q.text));
    assert.ok(auditCall, 'should write audit_log');
    assert.equal(auditCall.params[1], 'setup_init');
  });

  it('audit_log write failure must not block setup success', async () => {
    const db = makeFakeDb({ initialUsers: [], throwAuditError: true });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });
    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'a@b.com', password: 'secure123' },
    });
    assert.equal(r.status, 201, 'must succeed even if audit fails');
  });

  it('cache is invalidated immediately after creation; the second status call sees the new state', async () => {
    const db = makeFakeDb({ initialUsers: [] });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });

    let r = await request(app, { method: 'GET', path: '/api/setup/status' });
    assert.equal(r.body.first_run, true);

    await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'a@b.com', password: 'secure123' },
    });

    r = await request(app, { method: 'GET', path: '/api/setup/status' });
    assert.equal(r.body.first_run, false, 'status should update immediately after creation');
  });
});

// ============================================================
// Scenario 6: first_run=false: init is refused
// ============================================================

describe('v1.19.8 scenario 6 — POST /init must be refused when DB already has an admin', () => {
  it('returns 403 + message pointing to /admin/login', async () => {
    const db = makeFakeDb({
      initialUsers: [{ id: 'u1', email: 'existing@b.com', role: 'super_admin' }],
    });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });

    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'new@b.com', password: 'secure123' },
    });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /setup wizard 已完成|admin\/login/);
  });
});

// ============================================================
// Scenarios 7/8/9: field validation
// ============================================================

describe('v1.19.8 scenarios 7/8/9 — field validation', () => {
  function buildEmptyApp() {
    const db = makeFakeDb({ initialUsers: [] });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    return {
      app: buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector }),
      db,
    };
  }

  it('scenario 7: password too short → 400', async () => {
    const { app } = buildEmptyApp();
    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'a@b.com', password: 'short' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /至少 8/);
  });

  it('scenario 8: email format invalid → 400', async () => {
    const { app } = buildEmptyApp();
    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'not-an-email', password: 'secure123' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /email/i);
  });

  it('scenario 9: missing password → 400', async () => {
    const { app } = buildEmptyApp();
    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'a@b.com' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /email|password|欄位/);
  });

  it('missing email → 400', async () => {
    const { app } = buildEmptyApp();
    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { password: 'secure123' },
    });
    assert.equal(r.status, 400);
  });

  it('body undefined → 400, no throw', async () => {
    const { app } = buildEmptyApp();
    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: undefined,
    });
    assert.equal(r.status, 400);
  });
});

// ============================================================
// Scenario 10: race condition
// ============================================================

describe('v1.19.8 scenario 10 — race-condition guard', () => {
  // v1.19.8 code-review I-3 note:
  //   This test validates the "post-lock COUNT recheck" defense (after acquiring the lock,
  //   SELECT again; if count > 0, ROLLBACK) — not the serialization power of
  //   pg_advisory_xact_lock itself. Validating the real advisory lock requires a live Postgres
  //   connection and concurrent transactions, i.e. integration test territory; left to a
  //   future PGHOST-opt-in integration test.
  it('two concurrent inits: the first acquires the lock and creates; the second enters the transaction and sees count > 0 → 403', async () => {
    // Simulate: at the first transaction, users table is empty; meanwhile someone inserted a row;
    // at the second transaction, count > 0.
    let userCount = 0;
    let advisoryLockCalls = 0;
    const fakeQuery = async (text) => {
      if (/SELECT COUNT/i.test(text)) {
        return { rows: [{ n: userCount }] };
      }
      if (/pg_advisory_xact_lock/i.test(text)) {
        advisoryLockCalls += 1;
        if (advisoryLockCalls === 1) {
          // After the first request grabs the lock, simulate that the second request already created the user.
          userCount = 1;
        }
        return { rows: [] };
      }
      if (/INSERT INTO users/i.test(text)) {
        return { rows: [{ id: 'u1', api_key: 'k', email: 'a@b.com', role: 'super_admin' }] };
      }
      if (/INSERT INTO audit_logs/i.test(text)) {
        return { rows: [] };
      }
      return { rows: [] };
    };
    const withTransaction = async (fn) => fn({ query: fakeQuery });
    const detector = createFirstRunDetector({ query: fakeQuery });
    const app = buildApp({ query: fakeQuery, withTransaction, detector });

    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'second@b.com', password: 'secure123' },
    });
    assert.equal(r.status, 403, 'the other transaction sees count > 0 and is rejected');
  });
});

// ============================================================
// First-run cache behavior
// ============================================================

describe('v1.19.8 — first-run cache', () => {
  beforeEach(() => { /* each test gets an independent detector; no shared cache */ });

  it('first_run=false result is cached; the second call does not hit the DB', async () => {
    let queryCalls = 0;
    const fakeQuery = async () => {
      queryCalls += 1;
      return { rows: [{ n: 1 }] };
    };
    const detector = createFirstRunDetector({ query: fakeQuery });
    await detector.detectFirstRun();
    await detector.detectFirstRun();
    assert.equal(queryCalls, 1, 'second call should hit the cache, not the DB');
  });

  it('first_run=true is not cached; every call re-queries (avoids races)', async () => {
    let queryCalls = 0;
    const fakeQuery = async () => {
      queryCalls += 1;
      return { rows: [{ n: 0 }] };
    };
    const detector = createFirstRunDetector({ query: fakeQuery });
    await detector.detectFirstRun();
    await detector.detectFirstRun();
    assert.equal(queryCalls, 2, 'first_run=true must not cache');
  });

  it('invalidate() forces the next call to re-query', async () => {
    let queryCalls = 0;
    let n = 1;
    const fakeQuery = async () => {
      queryCalls += 1;
      return { rows: [{ n }] };
    };
    const detector = createFirstRunDetector({ query: fakeQuery });
    await detector.detectFirstRun(); // 1
    await detector.detectFirstRun(); // cached
    detector.invalidate();
    await detector.detectFirstRun(); // 2
    assert.equal(queryCalls, 2);
  });

  it('DB query failure → first_run=false (fail-open; do not mislead the user)', async () => {
    const fakeQuery = async () => { throw new Error('DB unreachable'); };
    const detector = createFirstRunDetector({
      query: fakeQuery,
      logger: { warn() {}, error() {} },
    });
    const r = await detector.detectFirstRun();
    assert.equal(r.firstRun, false);
    assert.equal(r.usersCount, -1);
  });
});
