/**
 * An admin could read every user's API key, the super_admin's included, from
 * GET /api/admin/users — and authentication looks the user up by key alone, so holding a
 * super_admin's key is being the super_admin. Every rule the server enforces between an
 * admin and a super_admin (no role changes, no deletes, no broadcasts, no work log) was
 * one copy button away from not applying.
 *
 * Now the list carries only the first eight characters, and a full key comes from
 * GET /api/admin/users/:id/api-key, one user at a time, for yourself or for someone who
 * ranks below you, and every reveal is written to the audit log.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createAdminApiKeyRouter } from '../src/routes/admin-api-key.js';
import { mayRevealKeyOf } from '../src/utils/roles.js';
import { canRevealKeyOf, visibleMenuItems } from '../client/src/pages/Admin/menu-visibility.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const USERS = {
  1: { id: 1, role: 'super_admin', api_key: '11111111-aaaa-bbbb-cccc-000000000001' },
  2: { id: 2, role: 'super_admin', api_key: '22222222-aaaa-bbbb-cccc-000000000002' },
  3: { id: 3, role: 'admin', api_key: '33333333-aaaa-bbbb-cccc-000000000003' },
  4: { id: 4, role: 'admin', api_key: '44444444-aaaa-bbbb-cccc-000000000004' },
  5: { id: 5, role: 'user', api_key: '55555555-aaaa-bbbb-cccc-000000000005' },
};

function buildApp(actor, calls = []) {
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM users WHERE id/i.test(sql)) {
      const u = USERS[params[0]];
      return { rows: u ? [u] : [] };
    }
    return { rows: [] };
  };
  const router = createAdminApiKeyRouter({
    query,
    adminAuth: (req, res, next) => { req.user = actor; next(); },
    logger: { warn() {}, error() {}, info() {} },
  });
  const app = express();
  app.use('/api/admin/users', router);
  return app;
}

function get(app, path) {
  return new Promise((resolve) => {
    const headers = {};
    const req = { method: 'GET', url: path, path, originalUrl: path, headers: {} };
    const res = {
      statusCode: 200,
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      getHeader(k) { return headers[k.toLowerCase()]; },
      set(k, v) { headers[k.toLowerCase()] = v; return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, headers }); return this; },
      end(body) { resolve({ status: this.statusCode, body, headers }); return this; },
    };
    app(req, res, (err) => resolve({ status: err ? 500 : 404, body: null, headers }));
  });
}

describe('the user list no longer carries anyone\'s full key', () => {
  const src = readFileSync(join(repoRoot, 'src/routes/admin.js'), 'utf8');
  const select = src.match(/SELECT[\s\S]{0,400}FROM users ORDER BY created_at DESC/)[0];

  it('returns an eight-character prefix, not api_key', () => {
    assert.match(select, /LEFT\(api_key, 8\) AS api_key_prefix/);
    assert.doesNotMatch(select.replace(/LEFT\(api_key, 8\) AS api_key_prefix/, ''), /api_key/);
  });
});

describe('GET /api/admin/users/:id/api-key — only your own, or someone below you', () => {
  const cases = [
    // [actor, target, allowed]
    [3, 1, false, 'an admin cannot take a super_admin\'s key (the escalation this fixes)'],
    [3, 4, false, 'an admin cannot take another admin\'s key'],
    [3, 5, true, 'an admin can take a member\'s key, to hand them an install prompt'],
    [3, 3, true, 'an admin can take their own key'],
    [1, 2, false, 'a super_admin cannot take another super_admin\'s key'],
    [1, 3, true, 'a super_admin can take an admin\'s key'],
    [1, 5, true, 'a super_admin can take a member\'s key'],
    [1, 1, true, 'a super_admin can take their own key'],
  ];
  for (const [actorId, targetId, allowed, label] of cases) {
    it(label, async () => {
      const r = await get(buildApp(USERS[actorId]), `/api/admin/users/${targetId}/api-key`);
      if (allowed) {
        assert.equal(r.status, 200);
        assert.equal(r.body.api_key, USERS[targetId].api_key);
      } else {
        assert.equal(r.status, 403);
        assert.equal(JSON.stringify(r.body).includes(USERS[targetId].api_key), false);
      }
    });
  }

  it('every reveal and every refusal is written to the audit log, never with the key', async () => {
    const calls = [];
    await get(buildApp(USERS[3], calls), '/api/admin/users/5/api-key');
    const audit = calls.filter((c) => /INSERT INTO audit_logs/i.test(c.sql));
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].params.slice(0, 4), [3, 'reveal_api_key', 'user', 5]);
    assert.equal(JSON.stringify(audit[0].params).includes(USERS[5].api_key), false, 'the key itself is never logged');

    const refused = [];
    await get(buildApp(USERS[3], refused), '/api/admin/users/1/api-key');
    const denied = refused.filter((c) => /INSERT INTO audit_logs/i.test(c.sql));
    assert.equal(denied.length, 1, 'an admin probing for the super_admin\'s key leaves a row');
    assert.deepEqual(denied[0].params.slice(0, 4), [3, 'reveal_api_key_denied', 'user', 1]);
    assert.equal(JSON.stringify(denied[0].params).includes(USERS[1].api_key), false);
  });

  it('the answer is not cached', async () => {
    const r = await get(buildApp(USERS[3]), '/api/admin/users/5/api-key');
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  it('an unknown user is 404, and an id that is not a number is 400', async () => {
    assert.equal((await get(buildApp(USERS[1]), '/api/admin/users/999/api-key')).status, 404);
    assert.equal((await get(buildApp(USERS[1]), '/api/admin/users/abc/api-key')).status, 400);
    assert.equal((await get(buildApp(USERS[1]), '/api/admin/users/99999999999/api-key')).status, 400,
      'beyond a database integer is a bad id, not a server error');
  });

  it('the router is mounted where the dashboard calls it', () => {
    const app = readFileSync(join(repoRoot, 'src/app.js'), 'utf8');
    assert.match(app, /app\.use\('\/api\/admin\/users', adminApiKeyRoutes\)/);
  });
});

describe('the dashboard offers a key only where the server would hand it over', () => {
  const roles = ['user', 'admin', 'super_admin'];
  it('the client rule and the server rule agree on every pairing', () => {
    for (const a of roles) {
      for (const t of roles) {
        for (const self of [true, false]) {
          const actor = { id: 1, role: a };
          const row = { id: self ? 1 : 2, role: self ? a : t };
          assert.equal(canRevealKeyOf(actor, row), mayRevealKeyOf(actor, row), `${a} → ${row.role} self=${self}`);
        }
      }
    }
  });

  it('an admin is not shown the install prompt for a super_admin', () => {
    assert.ok(!visibleMenuItems({ id: 3, role: 'admin' }, { id: 1, role: 'super_admin' }).includes('install-prompt'));
    assert.ok(visibleMenuItems({ id: 3, role: 'admin' }, { id: 5, role: 'user' }).includes('install-prompt'));
  });

  it('the team page fetches a key on demand instead of reading it from the list', () => {
    const page = readFileSync(join(repoRoot, 'client/src/pages/Admin/TeamPage.jsx'), 'utf8');
    assert.doesNotMatch(page, /row\.api_key\b/);
    assert.match(page, /\/api\/admin\/users\/\$\{row\.id\}\/api-key/);
  });
});
