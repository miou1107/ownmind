/**
 * v1.19.8 — firstRunRedirect middleware 整合測試
 *
 * 對應 openspec/changes/v1.19.8-setup-wizard/spec.md 場景 1、2、3。
 * 補 code-review I-2 指出的覆蓋缺口（原本只靠讀程式碼、沒測試）。
 *
 * 用 createFirstRunRedirect factory 注入 fake detector、避免測試打 DB。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createFirstRunRedirect } from '../src/middleware/first-run-redirect.js';

/**
 * 建一個 detector 的 fake、可指定回傳值或丟例外
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
  // 假的終點、模擬 static serve 行為
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
// 場景 1：DB 為空 + /admin/* → redirect 到 /setup
// ============================================================

describe('v1.19.8 場景 1 — first_run=true 時 /admin/* 自動 redirect 到 /setup', () => {
  it('/admin/login → 302 /setup', async () => {
    const app = buildApp(fakeDetector({ firstRun: true }));
    const r = await request(app, { method: 'GET', path: '/admin/login' });
    assert.equal(r.status, 302);
    assert.equal(r.redirect, '/setup');
  });

  it('/admin/users（任何 /admin/* 子路徑）→ 302 /setup', async () => {
    const app = buildApp(fakeDetector({ firstRun: true }));
    const r = await request(app, { method: 'GET', path: '/admin/users' });
    assert.equal(r.status, 302);
    assert.equal(r.redirect, '/setup');
  });
});

// ============================================================
// 場景 2：DB 有 admin → /setup 自動 redirect 到 /admin/login
// ============================================================

describe('v1.19.8 場景 2 — first_run=false 時 /setup 自動 redirect 到 /admin/login', () => {
  it('GET /setup → 302 /admin/login', async () => {
    const app = buildApp(fakeDetector({ firstRun: false }));
    const r = await request(app, { method: 'GET', path: '/setup' });
    assert.equal(r.status, 302);
    assert.equal(r.redirect, '/admin/login');
  });
});

// ============================================================
// 場景 3：DB 有 admin → /admin/login 正常顯示
// ============================================================

describe('v1.19.8 場景 3 — first_run=false 時 /admin/* 正常通過', () => {
  it('GET /admin/login → 200 不被 redirect', async () => {
    const app = buildApp(fakeDetector({ firstRun: false }));
    const r = await request(app, { method: 'GET', path: '/admin/login' });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'admin-login-page');
  });
});

// ============================================================
// 邊界：非 /admin、非 /setup 路徑不被攔截
// ============================================================

describe('v1.19.8 — middleware 不影響無關路徑', () => {
  it('first_run=true、GET /other → 正常通過', async () => {
    const app = buildApp(fakeDetector({ firstRun: true }));
    const r = await request(app, { method: 'GET', path: '/other' });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'other-page');
  });

  it('first_run=true、GET /api/anything → 正常通過（不被 redirect）', async () => {
    // 場景：使用者開到 wizard 後、前端 JS 打 /api/setup/status —— 不該被 redirect
    const app = buildApp(fakeDetector({ firstRun: true }));
    const r = await request(app, { method: 'GET', path: '/api/anything' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  });
});

// ============================================================
// Fail-open：DB 連不上時不誤導使用者
// ============================================================

describe('v1.19.8 — fail-open：DB 失敗時 middleware 放行', () => {
  it('detectFirstRun 拋例外、/admin/login 不被 redirect（fail-open）', async () => {
    const app = buildApp(fakeDetector({ throws: 'DB down' }));
    const r = await request(app, { method: 'GET', path: '/admin/login' });
    assert.notEqual(r.redirect, '/setup');
    assert.equal(r.status, 200, '失敗時放行、顯示原本的 admin 頁');
  });

  it('detectFirstRun 拋例外、/setup 也正常通過', async () => {
    const app = buildApp(fakeDetector({ throws: 'DB down' }));
    const r = await request(app, { method: 'GET', path: '/setup' });
    assert.notEqual(r.redirect, '/admin/login');
    assert.equal(r.status, 200);
  });
});
