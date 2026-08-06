import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createDebugRouter } from '../src/routes/debug.js';

/**
 * v1.17.85 — install_check_logs.client_version must not be polluted by beacon sentinel
 *
 * Background: from v1.17.78, install_started / update_started beacons used the
 * literal strings "install-script" / "update-script" as client_version placeholders
 * (the target version is unknown when an upgrade begins). But server-side debug.js
 * wrote the sentinel straight into the client_version column → admin queries for
 * last_version pulled "update-script" instead of a real version, misjudging which
 * version users were stuck on.
 *
 * Fix: debug.js detects beacon triggers (install_started / update_started /
 * install_failed / update_failed / upgrade_failed_*) and forces client_version to NULL.
 * - install_check_logs still records the beacon (observability channel stays intact)
 * - but the client_version column only stores real versions, so admin queries stay correct.
 *
 * Historical data is not backfilled (small contamination, ~20 beacons after 5/8).
 */

function setupTestApp() {
  const insertedRows = [];
  const fakeQuery = async (sql, params) => {
    if (sql.includes('INSERT INTO install_check_logs')) {
      insertedRows.push({
        user_id: params[0], ts: params[1], client_version: params[2],
        platform: params[3], trigger_kind: params[4], machine: params[5],
        summary: params[6], full_log: params[7],
      });
      return { rows: [] };
    }
    return { rows: [] };
  };
  const fakeAuth = (req, res, next) => { req.user = { id: 99 }; next(); };
  const app = express();
  app.use(express.json());
  // onReportStored: skip the real install-check-alerts evaluator — these tests
  // exercise client_version handling with a fake `query` it isn't built for.
  app.use('/api/debug', createDebugRouter({ query: fakeQuery, auth: fakeAuth, onReportStored: async () => {} }));
  return { app, insertedRows };
}

async function post(app, payload) {
  const port = await new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv.address().port));
    app._server = srv;
  });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/debug/install-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: r.status, body: await r.json() };
  } finally {
    app._server.close();
  }
}

describe('v1.17.85 — debug.js beacon trigger forces client_version to NULL', () => {
  it('install_started + sentinel client_version "install-script" → DB writes NULL', async () => {
    const { app, insertedRows } = setupTestApp();
    const r = await post(app, {
      ts: '2026-05-11T03:50:00Z',
      trigger: 'install_started',
      client_version: 'install-script',
      platform: 'win32',
    });
    assert.equal(r.status, 200);
    assert.equal(insertedRows.length, 1);
    assert.equal(insertedRows[0].client_version, null,
      'beacon trigger client_version must be NULL, cannot let "install-script" pollute the column');
    assert.equal(insertedRows[0].trigger_kind, 'install_started',
      'trigger_kind must still be preserved (observability channel intact)');
  });

  it('update_started + sentinel "update-script" → DB writes NULL', async () => {
    const { app, insertedRows } = setupTestApp();
    const r = await post(app, {
      ts: '2026-05-11T03:50:00Z',
      trigger: 'update_started',
      client_version: 'update-script',
      platform: 'darwin',
    });
    assert.equal(r.status, 200);
    assert.equal(insertedRows[0].client_version, null);
  });

  it('install_failed_terminal_* (added in v1.17.85) → DB writes NULL', async () => {
    const { app, insertedRows } = setupTestApp();
    const r = await post(app, {
      ts: '2026-05-11T03:50:00Z',
      trigger: 'upgrade_failed_terminal_no_ownmind',
      client_version: 'unknown',  // on FAIL there may also be no real version
      platform: 'win32',
    });
    assert.equal(r.status, 200);
    assert.equal(insertedRows[0].client_version, null);
  });

  it('normal self-check report (post_install / manual / post_upgrade) → keeps real version', async () => {
    const { app, insertedRows } = setupTestApp();
    const r = await post(app, {
      ts: '2026-05-11T03:50:00Z',
      trigger: 'post_install',
      client_version: '1.17.85',
      platform: 'darwin',
      checks: [{ name: 'mcp_files', status: 'pass', detail: 'ok' }],
      summary: { pass: 1, warn: 0, fail: 0 },
    });
    assert.equal(r.status, 200);
    assert.equal(insertedRows[0].client_version, '1.17.85',
      'normal report must preserve real version');
  });

  it('normal self-check but client_version happens to be sentinel must also be kept (guard against over-zealous filter)', async () => {
    // Edge case: trigger is not a beacon but client_version coincidentally matches sentinel string
    // Design choice: only look at trigger, not client_version content — simple and predictable
    const { app, insertedRows } = setupTestApp();
    const r = await post(app, {
      ts: '2026-05-11T03:50:00Z',
      trigger: 'manual',
      client_version: 'install-script',  // weird case, but no filtering
      platform: 'darwin',
    });
    assert.equal(r.status, 200);
    assert.equal(insertedRows[0].client_version, 'install-script',
      'when trigger is not a beacon, keep client_version even if its content looks like a sentinel');
  });

  it('existing _step-level report (upgrade_dirty_tree / upgrade_npm_install_failed) → keeps real version', async () => {
    // reviewer I1: trailing underscore enforcement stops existing caller-level errors from misfiring
    // existing caller-level reports lack the _failed_ infix and won't be treated as beacons
    const cases = [
      { trigger: 'upgrade_dirty_tree', expect: '1.17.85' },
      { trigger: 'upgrade_npm_install_failed', expect: '1.17.85' },  // trailing _failed, not _failed_
      { trigger: 'upgrade_git_pull_failed', expect: '1.17.85' },
      { trigger: 'upgrade_file_locked', expect: '1.17.85' },
    ];
    for (const c of cases) {
      const { app, insertedRows } = setupTestApp();
      const r = await post(app, {
        ts: '2026-05-11T03:50:00Z',
        trigger: c.trigger,
        client_version: '1.17.85',
        platform: 'darwin',
      });
      assert.equal(r.status, 200);
      assert.equal(insertedRows[0].client_version, c.expect,
        `${c.trigger} should not be treated as a beacon, must preserve real version`);
    }
  });

  it('beacon prefix trailing underscore guards against misfiring (upgrade_failedtest ≠ upgrade_failed_*)', async () => {
    // Guards against future fat-fingered names like upgrade_failedtest being treated as a beacon
    const { app, insertedRows } = setupTestApp();
    await post(app, {
      ts: '2026-05-11T03:50:00Z',
      trigger: 'upgrade_failedtest',  // no underscore, not a beacon
      client_version: '1.17.85',
      platform: 'darwin',
    });
    assert.equal(insertedRows[0].client_version, '1.17.85',
      'upgrade_failedtest should not misfire as an upgrade_failed_* beacon');
  });

  it('beacon trigger but client_version is a real version (sent by v1.17.85+ upgrade script) → also writes NULL', async () => {
    // Design choice: beacon triggers always write NULL, ignoring client_version content
    // Reason: a beacon's client_version is unreliable (mid upgrade), even a real version
    // should not count as last_version evidence
    const { app, insertedRows } = setupTestApp();
    const r = await post(app, {
      ts: '2026-05-11T03:50:00Z',
      trigger: 'install_started',
      client_version: '1.17.85',  // hypothetical future script sending real version
      platform: 'win32',
    });
    assert.equal(r.status, 200);
    assert.equal(insertedRows[0].client_version, null,
      'beacon triggers always write NULL (last_version may only come from self-check report)');
  });
});
