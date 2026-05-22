/**
 * v1.19.9 — POST /api/admin/users/:id/reset-password 測試
 *
 * 對應 openspec/changes/v1.19.9-password-recovery/spec.md 場景 1-7。
 *
 * Factory pattern：用 createAdminPasswordResetRouter 注入 query / adminAuth、
 * 不打真 DB、好測試。
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
 * fake adminAuth：直接餵 req.user（由 buildApp 的閉包提供）
 */
function fakeAdminAuth(user) {
  return (req, res, next) => {
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    req.user = user;
    next();
  };
}

/**
 * fake isAtLeast：對齊 src/middleware/adminAuth.js 行為
 */
function fakeIsAtLeast(role, required) {
  const order = { user: 1, admin: 2, super_admin: 3 };
  return (order[role] || 0) >= (order[required] || 99);
}

/**
 * 建一個 mock query 函式、模擬 DB 行為
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
// generateTempPassword 純函式測試
// ============================================================

describe('v1.19.9 — generateTempPassword 純函式', () => {
  it('產出 12 字長度', () => {
    assert.equal(generateTempPassword().length, 12);
  });

  it('必含大寫+小寫+數字', () => {
    for (let i = 0; i < 20; i++) {
      const pwd = generateTempPassword();
      assert.match(pwd, /[A-Z]/, `${pwd} 應含大寫`);
      assert.match(pwd, /[a-z]/, `${pwd} 應含小寫`);
      assert.match(pwd, /[0-9]/, `${pwd} 應含數字`);
    }
  });

  it('不含混淆字 0/O/I/l/1', () => {
    for (let i = 0; i < 50; i++) {
      const pwd = generateTempPassword();
      assert.doesNotMatch(pwd, /[0OIl1]/, `${pwd} 不該含混淆字`);
    }
  });

  it('連續 20 次都不同（夠隨機）', () => {
    const set = new Set();
    for (let i = 0; i < 20; i++) {
      set.add(generateTempPassword());
    }
    assert.equal(set.size, 20, '20 次該全部不同');
  });

  it('支援自訂長度', () => {
    assert.equal(generateTempPassword(16).length, 16);
    assert.equal(generateTempPassword(20).length, 20);
  });
});

// ============================================================
// 場景 1：super_admin 重設 admin 密碼
// ============================================================

describe('v1.19.9 場景 1 — super_admin 重設 admin', () => {
  it('成功、回 temporary_password + must_change_password=true', async () => {
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

  it('UPDATE 時把 must_change_password 設 TRUE', async () => {
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
    assert.ok(updateCall, '應呼叫 UPDATE');
    assert.match(updateCall.sql, /must_change_password\s*=\s*TRUE/i);
  });
});

// ============================================================
// 場景 2：admin 重設 user
// ============================================================

describe('v1.19.9 場景 2 — admin 重設 user', () => {
  it('admin 可重設 user 角色帳號', async () => {
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
// 場景 3：admin 不能重設其他 admin
// ============================================================

describe('v1.19.9 場景 3 — admin 不能重設其他 admin', () => {
  it('admin 重設另一個 admin → 403', async () => {
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

  it('admin 重設 super_admin → 403', async () => {
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
// 場景 4：不能重設自己
// ============================================================

describe('v1.19.9 場景 4 — 不能重設自己', () => {
  it('super_admin 重設自己 → 400 + 引導去 change-password', async () => {
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

  it('admin 重設自己 → 400', async () => {
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
// 場景 5：target 不存在
// ============================================================

describe('v1.19.9 場景 5 — target 不存在', () => {
  it('回 404', async () => {
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
// 場景 6+7：未登入 / user role 由 adminAuth 擋
// ============================================================

describe('v1.19.9 場景 6 — 未登入', () => {
  it('回 401', async () => {
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
// Audit log 寫入
// ============================================================

describe('v1.19.9 — audit log 寫入', () => {
  it('成功時呼叫 INSERT INTO audit_logs、action=reset_password_by_admin', async () => {
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
    assert.ok(auditCall, '應寫 audit_log');
    assert.equal(auditCall.params[1], 'reset_password_by_admin');
    assert.equal(auditCall.params[2], 'user');
    assert.equal(auditCall.params[3], 2);
  });
});

// ============================================================
// bcrypt 端到端驗證
// ============================================================

describe('v1.19.9 — 臨時密碼能用 bcrypt.compare 驗證', () => {
  it('回傳的 temporary_password 跟寫進 DB 的 hash 一致', async () => {
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
    assert.equal(valid, true, '回傳密碼應能驗證寫入的 hash');
  });
});
