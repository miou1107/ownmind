import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createDebugRouter } from '../src/routes/debug.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.78 — install_started beacon observability channel (IR-038, reported by vin-windows-test)
 *
 * Root cause: before v1.17.77, install_check_logs.user_id=8 had 0 rows entirely.
 * Investigation found the root cause = the mid-script npm install in install.ps1 was
 * blocked by ExecutionPolicy and exited 1, so the end-of-file self-check.cjs never ran
 * → admin could not see "user attempted install".
 * v1.17.76 fixed ExecutionPolicy, but any other mid-script failure (winget failure,
 * git clone failure, etc.) would still exit 1 → same blind spot.
 *
 * Structural fix: install.ps1 / install.sh send an install_started beacon immediately
 * after the API key is confirmed. To send it, the server endpoint must accept a minimal
 * body without checks/summary.
 */

describe('debug route — install-check accepts a minimal beacon (v1.17.78)', () => {
  let app;
  let server;
  let baseUrl;
  let inserted;

  function makeAuth(userId) {
    return (req, _res, next) => { req.user = { id: userId }; next(); };
  }

  function makeQuery() {
    return async (sql, params) => {
      if (/INSERT INTO install_check_logs/.test(sql)) {
        inserted.push({ sql, params });
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
  }

  beforeEach(async () => {
    inserted = [];
    app = express();
    app.use(express.json());
    // onReportStored: skip the real install-check-alerts evaluator — these tests
    // exercise the beacon endpoint with a fake `query` it isn't built for.
    app.use('/api/debug', createDebugRouter({ query: makeQuery(), auth: makeAuth(8), onReportStored: async () => {} }));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}/api/debug/install-check`;
        resolve();
      });
    });
  });

  // Close the server after each it, otherwise node --test never exits
  async function post(body) {
    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('accepts a beacon with only ts + trigger (no checks / summary)', async () => {
    const r = await post({
      ts: '2026-05-08T17:00:00Z',
      trigger: 'install_started',
      client_version: 'install-script',
      platform: 'win32',
      machine: 'DESKTOP-XYZ',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].params[4], 'install_started'); // trigger_kind
  });

  it('still accepts a full self-check report as before (backward compatible)', async () => {
    const r = await post({
      ts: '2026-05-08T17:00:00Z',
      trigger: 'post_install',
      client_version: '1.17.78',
      platform: 'darwin',
      machine: 'mac.local',
      checks: [{ name: 'mcp_files', status: 'pass', detail: 'OK' }],
      summary: { pass: 1, warn: 0, fail: 0 },
    });
    assert.equal(r.status, 200);
    assert.equal(inserted.length, 1);
  });

  it('still rejects when ts is missing (only ts is mandatory)', async () => {
    const r = await post({ trigger: 'install_started' });
    assert.equal(r.status, 400);
  });

  it('still rejects when checks is provided but not an array', async () => {
    const r = await post({ ts: '2026-05-08T17:00:00Z', checks: 'oops' });
    assert.equal(r.status, 400);
  });

  it('still rejects when checks[*].status is invalid', async () => {
    const r = await post({
      ts: '2026-05-08T17:00:00Z',
      checks: [{ name: 'x', status: 'whatever' }],
      summary: {},
    });
    assert.equal(r.status, 400);
  });
});

describe('install scripts — must send the install_started beacon (v1.17.78)', () => {
  it('install.ps1 contains a Send-InstallBeacon call', () => {
    const content = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');
    assert.match(content, /Send-InstallBeacon/);
    assert.match(content, /install_started/);
    assert.match(content, /\/api\/debug\/install-check/);
  });

  it('install.sh contains a send_install_beacon call', () => {
    const content = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
    assert.match(content, /send_install_beacon/);
    assert.match(content, /install_started/);
    assert.match(content, /\/api\/debug\/install-check/);
  });
});

