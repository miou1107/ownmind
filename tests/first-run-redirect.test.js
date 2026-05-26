/**
 * v1.19.8 — firstRunRedirect middleware integration tests
 *
 * Maps to openspec/changes/v1.19.8-setup-wizard/spec.md scenarios 1, 2, 3.
 * Closes the coverage gap raised in code-review I-2 (previously verified only by reading code).
 *
 * Uses the createFirstRunRedirect factory to inject a fake detector so the tests do not hit the DB.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createFirstRunRedirect } from '../src/middleware/first-run-redirect.js';

/**
 * Build a detector fake whose return value or thrown error is configurable.
 */
function fakeDetector({ firstRun, throws } = {}) {
  return {
    detectFirstRun: async () => {
      if (throws) throw new Error(throws);
      return { firstRun, usersCount: firstRun ? 0 : 1 };
    },
  };
}

function buildApp(detector) {
  const app = express();
  app.use(createFirstRunRedirect({ detectFirstRun: detector.detectFirstRun }));
  // Fake endpoints that mimic static-serve behavior.
  app.get('/admin/login', (req, res) => res.status(200).send('admin-login-page'));
  app.get('/admin/users', (req, res) => res.status(200).send('admin-users-page'));
  app.get('/setup', (req, res) => res.status(200).send('setup-wizard-page'));
  app.get('/api/anything', (req, res) => res.status(200).json({ ok: true }));
  app.get('/other', (req, res) => res.status(200).send('other-page'));
  return app;
}

async function request(app, { method, path, headers = {} }) {
  return await new Promise((resolve) => {
    const req = {
      method,
      url: path,
      path,
      originalUrl: path,
      headers,
      get(name) { return headers[name.toLowerCase()]; },
    };
    let redirectLocation = null;
    let redirectStatus = null;
    const res = {
      statusCode: 200,
      _body: null,
      _headers: {},
      setHeader(k, v) { this._headers[k] = v; },
      getHeader(k) { return this._headers[k]; },
      status(code) { this.statusCode = code; return this; },
      json(b) { this._body = b; resolve({ status: this.statusCode, body: b, redirect: null }); return this; },
      send(b) { this._body = b; resolve({ status: this.statusCode, body: b, redirect: redirectLocation }); return this; },
      end(b) {
        this._body = b;
        resolve({ status: this.statusCode, body: b, redirect: redirectLocation });
        return this;
      },
      redirect(arg1, arg2) {
        if (typeof arg1 === 'number') {
          redirectStatus = arg1;
          redirectLocation = arg2;
        } else {
          redirectStatus = 302;
          redirectLocation = arg1;
        }
        this.statusCode = redirectStatus;
        resolve({ status: redirectStatus, body: null, redirect: redirectLocation });
      },
    };
    app(req, res, (err) => {
      if (err) resolve({ status: 500, body: { error: err.message }, redirect: null });
    });
  });
}

// ============================================================
// Scenario 1: empty DB + /admin/* → redirect to /setup
// ============================================================

describe('v1.19.8 scenario 1 — when first_run=true, /admin/* auto-redirects to /setup', () => {
  it('/admin/login → 302 /setup', async () => {
    const app = buildApp(fakeDetector({ firstRun: true }));
    const r = await request(app, { method: 'GET', path: '/admin/login' });
    assert.equal(r.status, 302);
    assert.equal(r.redirect, '/setup');
  });

  it('/admin/users (any /admin/* sub-path) → 302 /setup', async () => {
    const app = buildApp(fakeDetector({ firstRun: true }));
    const r = await request(app, { method: 'GET', path: '/admin/users' });
    assert.equal(r.status, 302);
    assert.equal(r.redirect, '/setup');
  });
});

// ============================================================
// Scenario 2: DB already has admins → /setup auto-redirects to /admin/login
// ============================================================

describe('v1.19.8 scenario 2 — when first_run=false, /setup auto-redirects to /admin/login', () => {
  it('GET /setup → 302 /admin/login', async () => {
    const app = buildApp(fakeDetector({ firstRun: false }));
    const r = await request(app, { method: 'GET', path: '/setup' });
    assert.equal(r.status, 302);
    assert.equal(r.redirect, '/admin/login');
  });
});

// ============================================================
// Scenario 3: DB has admin → /admin/login renders normally
// ============================================================

describe('v1.19.8 scenario 3 — when first_run=false, /admin/* passes through unchanged', () => {
  it('GET /admin/login → 200, no redirect', async () => {
    const app = buildApp(fakeDetector({ firstRun: false }));
    const r = await request(app, { method: 'GET', path: '/admin/login' });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'admin-login-page');
  });
});

// ============================================================
// Boundary: non-/admin and non-/setup paths are not intercepted.
// ============================================================

describe('v1.19.8 — middleware does not affect unrelated paths', () => {
  it('first_run=true, GET /other → passes through', async () => {
    const app = buildApp(fakeDetector({ firstRun: true }));
    const r = await request(app, { method: 'GET', path: '/other' });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'other-page');
  });

  it('first_run=true, GET /api/anything → passes through (no redirect)', async () => {
    // Scenario: after the user opens the wizard, the frontend JS calls /api/setup/status — must not be redirected.
    const app = buildApp(fakeDetector({ firstRun: true }));
    const r = await request(app, { method: 'GET', path: '/api/anything' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  });
});

// ============================================================
// Fail-open: do not mislead users when the DB is unreachable.
// ============================================================

describe('v1.19.8 — fail-open: middleware lets requests through when the DB fails', () => {
  it('detectFirstRun throws, /admin/login is not redirected (fail-open)', async () => {
    const app = buildApp(fakeDetector({ throws: 'DB down' }));
    const r = await request(app, { method: 'GET', path: '/admin/login' });
    assert.notEqual(r.redirect, '/setup');
    assert.equal(r.status, 200, 'on failure, pass through and show the original admin page');
  });

  it('detectFirstRun throws, /setup also passes through', async () => {
    const app = buildApp(fakeDetector({ throws: 'DB down' }));
    const r = await request(app, { method: 'GET', path: '/setup' });
    assert.notEqual(r.redirect, '/admin/login');
    assert.equal(r.status, 200);
  });
});
