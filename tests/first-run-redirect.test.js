/**
 * firstRunRedirect middleware integration tests
 *
 * Originally v1.19.8; scenarios 1 and 2 were rewritten in v1.26.48 to assert
 * that Locations are relative (resolved against the request URL) rather than
 * absolute strings. See openspec/changes/archive/v1.26.48-flip-root-retire-me/spec.md
 * Requirement 3.
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

describe('scenario 1 — when first_run=true, /admin/* redirects to setup (v1.26.48: relative)', () => {
  it('/admin/login → 302; Location resolves to setup one level up', async () => {
    const app = buildApp(fakeDetector({ firstRun: true }));
    const r = await request(app, { method: 'GET', path: '/admin/login' });
    assert.equal(r.status, 302);
    assert.ok(r.redirect, 'Location must be set');
    assert.ok(
      !r.redirect.startsWith('/'),
      `Location must be relative (v1.26.48), got "${r.redirect}"`,
    );
    // /admin/login sits inside the /admin/ directory, so climbing one level
    // reaches the root; resolves to /setup under any prefix.
    const resolved = new URL(r.redirect, 'http://x/ownmind/admin/login').href;
    assert.equal(resolved, 'http://x/ownmind/setup');
  });

  it('/admin/users → 302; Location resolves to setup one level up', async () => {
    const app = buildApp(fakeDetector({ firstRun: true }));
    const r = await request(app, { method: 'GET', path: '/admin/users' });
    assert.equal(r.status, 302);
    assert.ok(!r.redirect.startsWith('/'));
    const resolved = new URL(r.redirect, 'http://x/ownmind/admin/users').href;
    assert.equal(resolved, 'http://x/ownmind/setup');
  });
});

// ============================================================
// Scenario 2: DB already has admins → /setup auto-redirects to /admin/login
// ============================================================

describe('scenario 2 — when first_run=false, /setup redirects to the console login', () => {
  it('GET /setup → 302; Location resolves to dashboard/login under both bases', async () => {
    const app = buildApp(fakeDetector({ firstRun: false }));
    const r = await request(app, { method: 'GET', path: '/setup' });
    assert.equal(r.status, 302);
    assert.ok(!r.redirect.startsWith('/'));
    assert.equal(new URL(r.redirect, 'http://x/setup').href, 'http://x/dashboard/login');
    assert.equal(new URL(r.redirect, 'http://x/ownmind/setup').href,
      'http://x/ownmind/dashboard/login');
  });

  it('specifically does not send anyone at the retired console', async () => {
    // v1.26.48 to v1.26.58 this pointed at `admin/login`, which answered
    // `Cannot GET /admin/login` — express.static with no file under `login/`. Retiring
    // /admin turned that into a redirect chain that lands somewhere right by accident.
    // Named as its own assertion so a revert reads as itself rather than as a URL diff.
    const app = buildApp(fakeDetector({ firstRun: false }));
    const r = await request(app, { method: 'GET', path: '/setup' });
    assert.ok(!r.redirect.includes('admin'), `still points at the old console: "${r.redirect}"`);
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
    assert.equal(r.redirect, null, 'fail-open must not redirect');
    assert.equal(r.status, 200, 'on failure, pass through and show the original admin page');
  });

  it('detectFirstRun throws, /setup also passes through', async () => {
    const app = buildApp(fakeDetector({ throws: 'DB down' }));
    const r = await request(app, { method: 'GET', path: '/setup' });
    assert.equal(r.redirect, null);
    assert.equal(r.status, 200);
  });
});

// ============================================================
// v1.26.48 — the root path is intercepted too, so a fresh install landing
// on / still reaches the wizard after Stage 1b flips the root redirect
// away from /admin/.
// ============================================================

describe('v1.26.48 scenario 4 — first_run=true, GET / redirects to setup', () => {
  it('GET / → 302; Location resolves to /setup at any prefix', async () => {
    const app = buildApp(fakeDetector({ firstRun: true }));
    // Need a fake / handler so pass-through would 200 rather than 404.
    app.get('/', (req, res) => res.status(200).send('root-page'));
    const r = await request(app, { method: 'GET', path: '/' });
    assert.equal(r.status, 302, 'first_run=true must not fall through to the console redirect');
    assert.ok(r.redirect, 'Location must be set');
    assert.ok(!r.redirect.startsWith('/'), `Location must be relative, got "${r.redirect}"`);
    assert.equal(new URL(r.redirect, 'http://x/ownmind/').href, 'http://x/ownmind/setup');
    assert.equal(new URL(r.redirect, 'http://x/').href, 'http://x/setup');
  });

  it('GET / with first_run=false → passes through to the next handler', async () => {
    const app = buildApp(fakeDetector({ firstRun: false }));
    app.get('/', (req, res) => res.status(200).send('root-page'));
    const r = await request(app, { method: 'GET', path: '/' });
    assert.equal(r.redirect, null);
    assert.equal(r.status, 200);
    assert.equal(r.body, 'root-page');
  });
});
