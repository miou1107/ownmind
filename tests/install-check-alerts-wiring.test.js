// tests/install-check-alerts-wiring.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createDebugRouter } from '../src/routes/debug.js';

function callRoute(deps, body, user = { id: 3 }) {
  return new Promise((resolve) => {
    const req = {
      method: 'POST', url: '/install-check', path: '/install-check',
      originalUrl: '/api/debug/install-check', baseUrl: '/api/debug',
      headers: {}, body,
    };
    const res = {
      statusCode: 200,
      setHeader() {}, getHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); return this; },
      end(b) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    const auth = (r, _res, next) => { r.user = user; next(); };
    createDebugRouter({ ...deps, auth })(req, res, () => resolve({ status: 500, body: null }));
  });
}

const VALID_BODY = {
  ts: '2026-08-06T10:00:00+08:00',
  trigger: 'post_upgrade',
  client_version: '1.26.86',
  platform: 'win32',
  machine: 'LAPTOP-MBGGLV2J',
  checks: [{ name: 'memory_load', status: 'fail', detail: 'WSL launcher', fix: 'Re-run the installer' }],
  summary: { pass: 9, warn: 0, fail: 1 },
};

describe('install-check alerting is wired to the upload', () => {
  it('evaluates alerts after a report is stored', async () => {
    let called = 0;
    const inserts = [];
    const res = await callRoute({
      query: async (sql, params) => { inserts.push({ sql, params }); return { rows: [], rowCount: 0 }; },
      onReportStored: async () => { called += 1; },
    }, VALID_BODY);

    assert.equal(res.status, 200);
    assert.equal(called, 1);
    assert.ok(inserts.some((c) => c.sql.includes('INSERT INTO install_check_logs')));
  });

  it('a failing evaluator does not cost the report', async () => {
    const inserts = [];
    const res = await callRoute({
      query: async (sql, params) => { inserts.push({ sql, params }); return { rows: [], rowCount: 0 }; },
      onReportStored: async () => { throw new Error('alerting is broken'); },
    }, VALID_BODY);

    assert.equal(res.status, 200, 'the upload must survive a broken alerter');
    assert.deepEqual(res.body, { ok: true });
    assert.ok(inserts.some((c) => c.sql.includes('INSERT INTO install_check_logs')),
      'the row must still be stored');
  });

  it('a rejected report does not trigger evaluation', async () => {
    let called = 0;
    const res = await callRoute({
      query: async () => ({ rows: [], rowCount: 0 }),
      onReportStored: async () => { called += 1; },
    }, { trigger: 'post_upgrade' }); // no ts -> 400

    assert.equal(res.status, 400);
    assert.equal(called, 0);
  });
});

describe('startup sweep', () => {
  it('src/index.js runs the sweep and swallows its failure', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.match(src, /runInstallCheckAlerts/);
    assert.match(src, /runInstallCheckAlerts\(\)[\s\S]{0,80}catch/);
  });
});
