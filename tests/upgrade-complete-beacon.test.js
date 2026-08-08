import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createDebugRouter } from '../src/routes/debug.js';

/**
 * v1.17.86 — upgrade_complete beacon (IR-038 observability gap fix)
 *
 * Background: the v1.17.85 FAIL fallback only covered the case where the upgrade flow was
 * interrupted by FAIL(); Bob / Dana hit a different scenario — the upgrade actually
 * succeeded (the client was on 1.17.84, confirmed by collector_heartbeat) but the
 * post_install self-check upload never succeeded. Possible causes:
 *   - self-check ran but the upload 401 / 5xx'd → wrote .upload-spool.jsonl and waited for
 *     the next retry, but the user quit Claude Code right after upgrading, so self-check
 *     never re-fires to drain the spool.
 *   - Windows-specific issues caused the self-check process to be interrupted.
 *   - Self-check logic got stuck mid-step when crossing multiple versions in a single upgrade.
 *
 * Net result: install_check_logs had no post_install rows → an admin reading
 * install_check_logs to see "which version is the user on" would misjudge (cross-reference
 * with collector_heartbeat).
 *
 * Fix: at the tail of a successful upgrade, fire a lightweight `upgrade_complete` beacon
 * (fire-and-forget + spool fallback); the payload only carries the real version + ts + machine,
 * not the full checks. It is sent before the self-check report and is simple enough not to stall.
 * Once the server receives it, install_check_logs has a row + the real version (unlike
 * install_started / update_started, which use a sentinel).
 *
 * This beacon coexists with the existing install_started / update_started:
 *   install_started → "upgrade starting" signal (client_version = sentinel)
 *   upgrade_complete → "upgrade complete" signal (client_version = real version)
 *   post_upgrade self-check → "upgrade verified" signal (full checks)
 *
 * Even if all three self-check steps fail, the server still sees upgrade_complete proving
 * the user upgraded to X.
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
  // exercise beacon handling with a fake `query` it isn't built for.
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

describe('v1.17.86 — interactive-upgrade.sh send_upgrade_complete_beacon behavior', () => {
  let tmpHome;

  function setup() {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-uc-beacon-'));
    const claudeDir = path.join(tmpHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true });
    // Write a fake settings.json with an invalid URL → forces curl to fail → exercises the spool fallback.
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        mcpServers: {
          ownmind: {
            env: {
              OWNMIND_API_KEY: 'test-key',
              OWNMIND_API_URL: 'http://127.0.0.1:1/ownmind',  // port 1 → must fail
            },
          },
        },
      })
    );
  }

  function cleanup() {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  it('bash: send_upgrade_complete_beacon spools on failure; payload contains the real version + upgrade_complete trigger', () => {
    setup();
    try {
      const fakeScript = `
        #!/usr/bin/env bash
        set -u
        # v1.26.88: the function calls to_win_path, which interactive-upgrade.sh sources at
        # the top. Source it here too, or this harness tests a version of the function that
        # cannot exist. (It is identity off Windows, so the payload is unchanged.)
        . "${path.join(repoRoot, 'scripts/install-helpers/path-helpers.sh')}"
        # Pull the real send_upgrade_complete_beacon function from interactive-upgrade.sh.
        eval "$(sed -n '/^send_upgrade_complete_beacon()/,/^}/p' "${path.join(repoRoot, 'scripts/interactive-upgrade.sh')}")"
        send_upgrade_complete_beacon "1.17.86-test"
      `;
      const r = spawnSync('bash', ['-c', fakeScript], {
        env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, OSTYPE: 'darwin' },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, 'beacon function must exit 0 even on failure; never block the upgrade');

      const spoolPath = path.join(tmpHome, '.ownmind', 'logs', '.upload-spool.jsonl');
      assert.ok(fs.existsSync(spoolPath), 'curl failure should fall back to the spool');

      const line = fs.readFileSync(spoolPath, 'utf8').trim();
      const rec = JSON.parse(line);
      assert.equal(rec.trigger, 'upgrade_complete');
      assert.equal(rec.client_version, '1.17.86-test',
        'real version is sent directly; not a sentinel');
      assert.ok(rec.ts);
      assert.ok(rec.machine);
    } finally { cleanup(); }
  });

  it('bash: interactive-upgrade.sh calls send_upgrade_complete_beacon at the end', () => {
    const content = fs.readFileSync(path.join(repoRoot, 'scripts/interactive-upgrade.sh'), 'utf8');
    assert.match(content, /^send_upgrade_complete_beacon\s+"\$\{?VERSION\}?"/m,
      'interactive-upgrade.sh must call the beacon with $VERSION at the tail of a successful upgrade');
  });

  it('SessionStart hook also runs retrySpool drain (reviewer I1 fix: shorten "user-upgrade-to-server-visible" latency)', () => {
    // Scenario: v1.17.86 added upgrade_complete beacon to fix the case where the server cannot
    // see a completed upgrade after self-check upload fails. But the beacon's own upload can
    // also fail and spool — originally it would wait for the next self-check to drain.
    // The user quit Claude Code immediately after upgrading → no next run → stuck.
    // Fix: SessionStart also calls retrySpool; any new session starts the drain.
    const content = fs.readFileSync(path.join(repoRoot, 'hooks/ownmind-session-start.sh'), 'utf8');
    assert.match(content, /retrySpool/,
      'SessionStart hook must call retrySpool to drain accumulated spool records');
    assert.match(content, /\.upload-spool/,
      'SessionStart comments / logic should reference the .upload-spool source');
    // fire-and-forget: must run in the background with `&`; must not block SessionStart.
    assert.match(content, /retrySpool[\s\S]{0,500}&/,
      'drain must be fire-and-forget in the background; never block SessionStart');
  });

  it('ps1: interactive-upgrade.ps1 contains Send-UpgradeCompleteBeacon function + call', () => {
    const content = fs.readFileSync(path.join(repoRoot, 'scripts/interactive-upgrade.ps1'), 'utf8');
    assert.match(content, /function Send-UpgradeCompleteBeacon/,
      'PS1 must define the Send-UpgradeCompleteBeacon function');
    assert.match(content, /Send-UpgradeCompleteBeacon\s+-ClientVersion\s+\$Version/,
      'PS1 must call Send-UpgradeCompleteBeacon -ClientVersion $Version at the end');
    assert.match(content, /trigger\s*=\s*'upgrade_complete'/,
      "PS1 beacon payload trigger must be 'upgrade_complete'");
  });
});

describe('v1.17.86 — upgrade_complete beacon: server recognizes it and keeps the real version', () => {
  it('upgrade_complete + real version → client_version is stored as the real version (not filtered as beacon-sentinel)', async () => {
    const { app, insertedRows } = setupTestApp();
    const r = await post(app, {
      ts: '2026-05-11T10:00:00Z',
      trigger: 'upgrade_complete',
      client_version: '1.17.86',
      platform: 'win32',
      machine: 'bob-laptop',
    });
    assert.equal(r.status, 200);
    assert.equal(insertedRows.length, 1);
    assert.equal(insertedRows[0].client_version, '1.17.86',
      'upgrade_complete is the "upgrade complete" signal; the real version must be kept');
    assert.equal(insertedRows[0].trigger_kind, 'upgrade_complete');
  });

  it('upgrade_complete behaves opposite to install_started / update_started', async () => {
    // install_started uses the sentinel "install-script" → filtered to NULL.
    // upgrade_complete uses the real version → kept.
    const { app, insertedRows } = setupTestApp();

    await post(app, {
      ts: '2026-05-11T10:00:00Z',
      trigger: 'install_started',
      client_version: 'install-script',
      platform: 'win32',
    });
    await post(app, {
      ts: '2026-05-11T10:00:30Z',
      trigger: 'upgrade_complete',
      client_version: '1.17.86',
      platform: 'win32',
    });

    assert.equal(insertedRows[0].client_version, null,
      'install_started sentinel should be filtered');
    assert.equal(insertedRows[1].client_version, '1.17.86',
      'upgrade_complete real version should be kept');
  });

  it('upgrade_complete + sentinel string (should not happen but defended) → still stored, not filtered', async () => {
    // Design choice: when trigger is upgrade_complete, trust the client_version the client sent.
    // After a completed upgrade the client necessarily knows the real version (reads package.json post-pull).
    const { app, insertedRows } = setupTestApp();
    const r = await post(app, {
      ts: '2026-05-11T10:00:00Z',
      trigger: 'upgrade_complete',
      client_version: 'install-script',  // should not happen but defended
      platform: 'win32',
    });
    assert.equal(r.status, 200);
    assert.equal(insertedRows[0].client_version, 'install-script',
      'trigger is not in the beacon-sentinel-trigger family; do not filter client_version');
  });
});
