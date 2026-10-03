/**
 * A leaked API key could not be revoked: nothing in the server ever wrote api_key after an
 * account was created, and changing a password left the key as it was. Authentication finds
 * a user by key alone, so a leaked key was the account, for good.
 *
 * POST /api/me/rotate-key replaces your own key. POST /api/admin/users/:id/rotate-key
 * replaces the key of someone ranked below you (or your own). The old key stops working at
 * once; the new one is returned exactly once and never written to the audit log.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createApiKeyRotateRouter } from '../src/routes/api-key-rotate.js';
import { visibleMenuItems } from '../client/src/pages/Admin/menu-visibility.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function freshUsers() {
  return {
    1: { id: 1, role: 'super_admin', api_key: 'key-super-1' },
    2: { id: 2, role: 'super_admin', api_key: 'key-super-2' },
    3: { id: 3, role: 'admin', api_key: 'key-admin-3' },
    4: { id: 4, role: 'admin', api_key: 'key-admin-4' },
    5: { id: 5, role: 'user', api_key: 'key-user-5' },
  };
}

function buildApp(actor, users, calls = []) {
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT id, role FROM users WHERE id/i.test(sql)) {
      const u = users[params[0]];
      return { rows: u ? [{ id: u.id, role: u.role }] : [] };
    }
    if (/UPDATE users SET api_key/i.test(sql)) {
      const u = users[params[1]];
      if (!u) return { rows: [] };
      u.api_key = params[0];
      return { rows: [{ id: u.id, api_key: u.api_key }] };
    }
    return { rows: [] };
  };
  const pass = (req, res, next) => { req.user = actor; next(); };
  const router = createApiKeyRotateRouter({
    query, auth: pass, adminAuth: pass, logger: { warn() {}, error() {}, info() {} },
  });
  const app = express();
  app.use('/api', router);
  return app;
}

function post(app, path) {
  return new Promise((resolve) => {
    const headers = {};
    const req = { method: 'POST', url: path, path, originalUrl: path, headers: {}, body: {} };
    const res = {
      statusCode: 200,
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      getHeader(k) { return headers[k.toLowerCase()]; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, headers }); return this; },
      end(body) { resolve({ status: this.statusCode, body, headers }); return this; },
    };
    app(req, res, (err) => resolve({ status: err ? 500 : 404, body: null, headers }));
  });
}

describe('POST /api/me/rotate-key — replace your own key', () => {
  it('issues a new random key, stores it, and returns it once', async () => {
    const users = freshUsers();
    const r = await post(buildApp(users[5], users), '/api/me/rotate-key');
    assert.equal(r.status, 200);
    assert.match(r.body.api_key, UUID);
    assert.notEqual(r.body.api_key, 'key-user-5');
    assert.equal(users[5].api_key, r.body.api_key, 'the old key no longer matches anyone');
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  it('a failed audit write still hands over the new key: the old one is already dead', async () => {
    const users = freshUsers();
    const app = (() => {
      const query = async (sql, params) => {
        if (/UPDATE users SET api_key/i.test(sql)) { users[5].api_key = params[0]; return { rows: [{ id: 5, api_key: params[0] }] }; }
        if (/INSERT INTO audit_logs/i.test(sql)) throw new Error('connection reset');
        return { rows: [] };
      };
      const pass = (req, res, next) => { req.user = users[5]; next(); };
      const a = express();
      a.use('/api', createApiKeyRotateRouter({ query, auth: pass, adminAuth: pass, logger: { warn() {}, error() {}, info() {} } }));
      return a;
    })();
    const r = await post(app, '/api/me/rotate-key');
    assert.equal(r.status, 200);
    assert.equal(r.body.api_key, users[5].api_key);
  });

  it('is audited without either key', async () => {
    const users = freshUsers();
    const calls = [];
    const r = await post(buildApp(users[5], users, calls), '/api/me/rotate-key');
    const audit = calls.filter((c) => /INSERT INTO audit_logs/i.test(c.sql));
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].params.slice(0, 4), [5, 'rotate_api_key', 'user', 5]);
    const logged = JSON.stringify(audit[0].params);
    assert.ok(!logged.includes(r.body.api_key) && !logged.includes('key-user-5'));
  });
});

describe('POST /api/admin/users/:id/rotate-key — only your own, or someone below you', () => {
  const cases = [
    [3, 5, true, 'an admin can replace a member\'s leaked key'],
    [3, 4, false, 'an admin cannot replace another admin\'s key'],
    [3, 1, false, 'an admin cannot replace the super_admin\'s key'],
    [1, 3, true, 'a super_admin can replace an admin\'s key'],
    [1, 2, false, 'a super_admin cannot replace another super_admin\'s key'],
    [1, 1, true, 'a super_admin can replace their own key'],
  ];
  for (const [actorId, targetId, allowed, label] of cases) {
    it(label, async () => {
      const users = freshUsers();
      const before = users[targetId].api_key;
      const calls = [];
      const r = await post(buildApp(users[actorId], users, calls), `/api/admin/users/${targetId}/rotate-key`);
      if (allowed) {
        assert.equal(r.status, 200);
        assert.equal(users[targetId].api_key, r.body.api_key);
        assert.notEqual(r.body.api_key, before);
      } else {
        assert.equal(r.status, 403);
        assert.equal(users[targetId].api_key, before, 'a refused rotation changes nothing');
        assert.ok(calls.some((c) => /INSERT INTO audit_logs/i.test(c.sql) && c.params[1] === 'rotate_api_key_denied'));
      }
    });
  }

  it('an unknown user is 404, a malformed id is 400', async () => {
    const users = freshUsers();
    assert.equal((await post(buildApp(users[1], users), '/api/admin/users/999/rotate-key')).status, 404);
    assert.equal((await post(buildApp(users[1], users), '/api/admin/users/x/rotate-key')).status, 400);
  });
});

describe('wiring', () => {
  it('the router is mounted under /api', () => {
    const app = readFileSync(join(repoRoot, 'src/app.js'), 'utf8');
    assert.match(app, /app\.use\('\/api', apiKeyRotateRoutes\)/);
  });

  it('the team page offers "replace key" exactly where the server allows it', () => {
    assert.ok(visibleMenuItems({ id: 3, role: 'admin' }, { id: 5, role: 'user' }).includes('rotate-key'));
    assert.ok(!visibleMenuItems({ id: 3, role: 'admin' }, { id: 1, role: 'super_admin' }).includes('rotate-key'));
    assert.ok(!visibleMenuItems({ id: 3, role: 'admin' }, { id: 4, role: 'admin' }).includes('rotate-key'));
    assert.ok(visibleMenuItems({ id: 3, role: 'admin' }, { id: 3, role: 'admin' }).includes('rotate-key'));
  });
});
