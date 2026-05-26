/**
 * v1.19.9 — POST /api/admin/users/:id/reset-password tests
 *
 * Tracks openspec/changes/v1.19.9-password-recovery/spec.md scenarios 1–7.
 *
 * Factory pattern: createAdminPasswordResetRouter injects query / adminAuth,
 * so we never hit a real DB — easy to test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcrypt';
import {
  createAdminPasswordResetRouter,
  generateTempPassword,
} from '../src/routes/admin-password-reset.js';

/**
 * fake adminAuth: just feeds req.user (provided by buildApp's closure).
 */
function fakeAdminAuth(user) {
  return (req, res, next) => {
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    req.user = user;
    next();
  };
}

/**
 * fake isAtLeast: mirrors src/middleware/adminAuth.js behavior.
 */
function fakeIsAtLeast(role, required) {
  const order = { user: 1, admin: 2, super_admin: 3 };
  return (order[role] || 0) >= (order[required] || 99);
}

/**
 * Build a mock query function that mimics DB behavior.
 */
function makeFakeQuery({ targetUser, captureCalls = [] }) {
  return async function fakeQuery(sql, params) {
    captureCalls.push({ sql, params });
    if (/SELECT.*FROM users WHERE id/i.test(sql)) {
      return targetUser ? { rows: [targetUser] } : { rows: [] };
    }
    if (/UPDATE users/i.test(sql) && /password_hash/i.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO audit_logs/i.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  };
}

function buildApp({ user, targetUser, captureCalls }) {
  const query = makeFakeQuery({ targetUser, captureCalls: captureCalls || [] });
  const router = createAdminPasswordResetRouter({
    query,
    adminAuth: fakeAdminAuth(user),
    isAtLeast: fakeIsAtLeast,
    logger: { warn() {}, error() {} },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin/users', router);
  return app;
}

async function request(app, { method, path, body }) {
  return await new Promise((resolve) => {
    const req = {
      method,
      url: path,
      path,
      originalUrl: path,
      headers: { 'content-type': 'application/json' },
      body: body || {},
    };
    const res = {
      statusCode: 200,
      _body: null,
      _headers: {},
      setHeader(k, v) { this._headers[k] = v; },
      getHeader(k) { return this._headers[k]; },
      status(code) { this.statusCode = code; return this; },
      json(b) { this._body = b; resolve({ status: this.statusCode, body: b }); return this; },
      send(b) { this._body = b; resolve({ status: this.statusCode, body: b }); return this; },
      end(b) { this._body = b; resolve({ status: this.statusCode, body: b }); return this; },
    };
    app(req, res, (err) => err && resolve({ status: 500, body: { error: err.message } }));
  });
}

// ============================================================
// generateTempPassword pure-function tests
// ============================================================

describe('v1.19.9 — generateTempPassword pure function', () => {
  it('produces a 12-char string', () => {
    assert.equal(generateTempPassword().length, 12);
  });

  it('always contains uppercase + lowercase + digit', () => {
    for (let i = 0; i < 20; i++) {
      const pwd = generateTempPassword();
      assert.match(pwd, /[A-Z]/, `${pwd} should contain uppercase`);
      assert.match(pwd, /[a-z]/, `${pwd} should contain lowercase`);
      assert.match(pwd, /[0-9]/, `${pwd} should contain a digit`);
    }
  });

  it('does not include confusing characters 0/O/I/l/1', () => {
    for (let i = 0; i < 50; i++) {
      const pwd = generateTempPassword();
      assert.doesNotMatch(pwd, /[0OIl1]/, `${pwd} should not contain confusing chars`);
    }
  });

  it('20 consecutive draws are all distinct (random enough)', () => {
    const set = new Set();
    for (let i = 0; i < 20; i++) {
      set.add(generateTempPassword());
    }
    assert.equal(set.size, 20, '20 draws should all differ');
  });

  it('supports a custom length', () => {
    assert.equal(generateTempPassword(16).length, 16);
    assert.equal(generateTempPassword(20).length, 20);
  });
});

// ============================================================
// Scenario 1: super_admin resets an admin's password
// ============================================================

describe('v1.19.9 scenario 1 — super_admin resets an admin', () => {
  it('success; returns temporary_password + must_change_password=true', async () => {
    const app = buildApp({
      user: { id: 1, role: 'super_admin' },
      targetUser: { id: 2, email: 'admin-b@x.com', name: 'B', role: 'admin' },
    });
    const r = await request(app, {
      method: 'POST',
      path: '/api/admin/users/2/reset-password',
      body: {},
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.id, 2);
    assert.equal(r.body.email, 'admin-b@x.com');
    assert.equal(r.body.name, 'B');
    assert.equal(typeof r.body.temporary_password, 'string');
    assert.equal(r.body.temporary_password.length, 12);
    assert.equal(r.body.must_change_password, true);
  });

  it('UPDATE sets must_change_password to TRUE', async () => {
    const calls = [];
    const app = buildApp({
      user: { id: 1, role: 'super_admin' },
      targetUser: { id: 2, email: 'b@x.com', name: 'B', role: 'admin' },
      captureCalls: calls,
    });
    await request(app, {
      method: 'POST',
      path: '/api/admin/users/2/reset-password',
      body: {},
    });
    const updateCall = calls.find((c) => /UPDATE users[\s\S]*SET password_hash/i.test(c.sql));
    assert.ok(updateCall, 'UPDATE should be called');
    assert.match(updateCall.sql, /must_change_password\s*=\s*TRUE/i);
  });
});

// ============================================================
// Scenario 2: admin resets a user
// ============================================================

describe('v1.19.9 scenario 2 — admin resets a user', () => {
  it('admin can reset a user-role account', async () => {
    const app = buildApp({
      user: { id: 2, role: 'admin' },
      targetUser: { id: 3, email: 'user-d@x.com', name: 'D', role: 'user' },
    });
    const r = await request(app, {
      method: 'POST',
      path: '/api/admin/users/3/reset-password',
      body: {},
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.email, 'user-d@x.com');
  });
});

// ============================================================
// Scenario 3: admin cannot reset another admin
// ============================================================

describe('v1.19.9 scenario 3 — admin cannot reset another admin', () => {
  it('admin resetting another admin → 403', async () => {
    const app = buildApp({
      user: { id: 2, role: 'admin' },
      targetUser: { id: 5, email: 'other-admin@x.com', name: 'E', role: 'admin' },
    });
    const r = await request(app, {
      method: 'POST',
      path: '/api/admin/users/5/reset-password',
      body: {},
    });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /admin 只能重設 user/);
  });

  it('admin resetting super_admin → 403', async () => {
    const app = buildApp({
      user: { id: 2, role: 'admin' },
      targetUser: { id: 1, email: 'super@x.com', name: 'A', role: 'super_admin' },
    });
    const r = await request(app, {
      method: 'POST',
      path: '/api/admin/users/1/reset-password',
      body: {},
    });
    assert.equal(r.status, 403);
  });
});

// ============================================================
// Scenario 4: cannot reset oneself
// ============================================================

describe('v1.19.9 scenario 4 — cannot reset oneself', () => {
  it('super_admin resetting self → 400 + pointer to change-password', async () => {
    const app = buildApp({
      user: { id: 1, role: 'super_admin' },
      targetUser: { id: 1, email: 's@x.com', name: 'S', role: 'super_admin' },
    });
    const r = await request(app, {
      method: 'POST',
      path: '/api/admin/users/1/reset-password',
      body: {},
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /不能重設自己|change-password/);
  });

  it('admin resetting self → 400', async () => {
    const app = buildApp({
      user: { id: 2, role: 'admin' },
      targetUser: { id: 2, email: 'a@x.com', name: 'A', role: 'admin' },
    });
    const r = await request(app, {
      method: 'POST',
      path: '/api/admin/users/2/reset-password',
      body: {},
    });
    assert.equal(r.status, 400);
  });
});

// ============================================================
// Scenario 5: target does not exist
// ============================================================

describe('v1.19.9 scenario 5 — target does not exist', () => {
  it('returns 404', async () => {
    const app = buildApp({
      user: { id: 1, role: 'super_admin' },
      targetUser: null,
    });
    const r = await request(app, {
      method: 'POST',
      path: '/api/admin/users/99999/reset-password',
      body: {},
    });
    assert.equal(r.status, 404);
    assert.match(r.body.error, /找不到/);
  });
});

// ============================================================
// Scenarios 6+7: unauthenticated / user role blocked by adminAuth
// ============================================================

describe('v1.19.9 scenario 6 — unauthenticated', () => {
  it('returns 401', async () => {
    const app = buildApp({
      user: null,
      targetUser: { id: 2, email: 'b@x.com', name: 'B', role: 'admin' },
    });
    const r = await request(app, {
      method: 'POST',
      path: '/api/admin/users/2/reset-password',
      body: {},
    });
    assert.equal(r.status, 401);
  });
});

// ============================================================
// Audit log writes
// ============================================================

describe('v1.19.9 — audit log writes', () => {
  it('on success, calls INSERT INTO audit_logs with action=reset_password_by_admin', async () => {
    const calls = [];
    const app = buildApp({
      user: { id: 1, role: 'super_admin' },
      targetUser: { id: 2, email: 'b@x.com', name: 'B', role: 'admin' },
      captureCalls: calls,
    });
    await request(app, {
      method: 'POST',
      path: '/api/admin/users/2/reset-password',
      body: {},
    });
    const auditCall = calls.find((c) => /INSERT INTO audit_logs/i.test(c.sql));
    assert.ok(auditCall, 'should write audit_log');
    assert.equal(auditCall.params[1], 'reset_password_by_admin');
    assert.equal(auditCall.params[2], 'user');
    assert.equal(auditCall.params[3], 2);
  });
});

// ============================================================
// bcrypt end-to-end verification
// ============================================================

describe('v1.19.9 — temporary password verifies via bcrypt.compare', () => {
  it('the returned temporary_password matches the hash written to the DB', async () => {
    const calls = [];
    const app = buildApp({
      user: { id: 1, role: 'super_admin' },
      targetUser: { id: 2, email: 'b@x.com', name: 'B', role: 'admin' },
      captureCalls: calls,
    });
    const r = await request(app, {
      method: 'POST',
      path: '/api/admin/users/2/reset-password',
      body: {},
    });
    const updateCall = calls.find((c) => /UPDATE users[\s\S]*SET password_hash/i.test(c.sql));
    const writtenHash = updateCall.params[0];
    const valid = await bcrypt.compare(r.body.temporary_password, writtenHash);
    assert.equal(valid, true, 'the returned password should verify against the stored hash');
  });
});
