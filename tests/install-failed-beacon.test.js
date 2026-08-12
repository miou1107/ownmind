import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.85 — interactive-upgrade FAIL function uniformly adds report_error
 * (IR-038 observability gap patch).
 *
 * Background: Bob (id=3) and Dana (id=6) ran update_started beacons on 5/10-11
 * and produced no post_install report afterwards — the upgrade clearly failed, but
 * the errors/ spool had zero entries. Tracing showed that interactive-upgrade.sh,
 * while most FAIL paths called report_error first, still had a few uncovered
 * branches (no_ownmind / no_git / cd_failed / install / verify_local), and
 * unexpected exits (syntax error / SIGTERM / unset var) were entirely uncaught.
 *
 * Fix: the FAIL function itself unconditionally fires a fallback report_error,
 * so we no longer rely on every caller remembering to call it first.
 */

describe('v1.17.85 — interactive-upgrade.sh writes errors/ observability when FAIL fires', () => {
  let tmpHome;
  let errorsDir;

  beforeEach(() => {
    tmpHome = tempDir('ownmind-fail-beacon-');
    // Mirror report-error helper + report-error.sh into tmpHome to simulate the user's .ownmind.
    const ownmindDir = path.join(tmpHome, '.ownmind');
    fs.mkdirSync(path.join(ownmindDir, 'scripts', 'install-helpers'), { recursive: true });
    fs.mkdirSync(path.join(ownmindDir, 'logs', 'errors'), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, 'scripts/install-helpers/report-error.cjs'),
      path.join(ownmindDir, 'scripts/install-helpers/report-error.cjs')
    );
    fs.copyFileSync(
      path.join(repoRoot, 'scripts/install-helpers/report-error.sh'),
      path.join(ownmindDir, 'scripts/install-helpers/report-error.sh')
    );
    errorsDir = path.join(ownmindDir, 'logs', 'errors');
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // A minimal stub that invokes FAIL, sourcing the real interactive-upgrade.sh FAIL function.
  function runMinimalUpgradeWithFail(failCode, failMsg) {
    const fakeUpgrade = `
      #!/usr/bin/env bash
      set -u
      OWNMIND_DIR="${path.join(tmpHome, '.ownmind')}"
      LOG_FILE="\${OWNMIND_DIR}/logs/upgrade-test.log"
      touch "\${LOG_FILE}"

      # source report-error helper (matches the top of interactive-upgrade.sh)
      if [ -f "\${OWNMIND_DIR}/scripts/install-helpers/report-error.sh" ]; then
        . "\${OWNMIND_DIR}/scripts/install-helpers/report-error.sh"
      else
        report_error() { :; }
      fi

      # ↓ Copy the FAIL function from the real interactive-upgrade.sh ↓
      eval "$(sed -n '/^FAIL()/,/^}/p' "${path.join(repoRoot, 'scripts/interactive-upgrade.sh')}")"

      FAIL "${failCode}" "${failMsg}"
    `;
    const result = spawnSync('bash', ['-c', fakeUpgrade], {
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
      encoding: 'utf8',
    });
    return result;
  }

  it('calling FAIL "no_ownmind" automatically writes one observability record into errors/', () => {
    const r = runMinimalUpgradeWithFail('no_ownmind', 'OwnMind dir not found');
    assert.equal(r.status, 1, 'FAIL must exit 1');

    const files = fs.readdirSync(errorsDir);
    assert.equal(files.length, 1, `errors/ should have 1 record; actual ${files.length}: ${files.join(',')}`);
    const fname = files[0];
    assert.match(fname, /upgrade_failed_terminal_no_ownmind\.json$/,
      'kind should be upgrade_failed_terminal_<original FAIL code>');

    const content = JSON.parse(fs.readFileSync(path.join(errorsDir, fname), 'utf8'));
    assert.equal(content.kind, 'upgrade_failed_terminal_no_ownmind');
    assert.match(content.detail, /OwnMind dir not found/);
  });

  it('calling FAIL "verify_local" also writes a record (does not rely on caller calling report_error first)', () => {
    const r = runMinimalUpgradeWithFail('verify_local', 'local files missing');
    assert.equal(r.status, 1);

    const files = fs.readdirSync(errorsDir);
    assert.ok(files.length >= 1, 'verify_local must also write a record');
    const fname = files.find((f) => f.includes('verify_local'));
    assert.ok(fname, 'kind should contain verify_local');
  });

  it('previous "caller called report_error before FAIL" case is not broken', () => {
    // Simulate: call report_error first, then FAIL → both entries land in errors/
    // (duplicate observability is fine; we don't want to miss any path).
    const fakeUpgrade = `
      #!/usr/bin/env bash
      set -u
      OWNMIND_DIR="${path.join(tmpHome, '.ownmind')}"
      LOG_FILE="\${OWNMIND_DIR}/logs/upgrade-test.log"
      touch "\${LOG_FILE}"
      . "\${OWNMIND_DIR}/scripts/install-helpers/report-error.sh"

      eval "$(sed -n '/^FAIL()/,/^}/p' "${path.join(repoRoot, 'scripts/interactive-upgrade.sh')}")"

      report_error "upgrade_git_pull_failed" "git pull failed with conflict" "\${LOG_FILE}"
      FAIL "git_pull" "Upgrade aborted"
    `;
    const result = spawnSync('bash', ['-c', fakeUpgrade], {
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);

    const files = fs.readdirSync(errorsDir);
    // Expected: 1 entry written by caller + 1 by the FAIL fallback = 2.
    assert.equal(files.length, 2,
      `should have 2 records (caller + FAIL fallback); actual ${files.length}: ${files.join(',')}`);

    const kinds = files.map((f) => f.match(/-\d+(?:_[a-zA-Z0-9_]+)?\d*-(.+)\.json$/)?.[1])
      .map((k) => k || '');
    assert.ok(files.some((f) => f.includes('upgrade_git_pull_failed')),
      'caller-written kind should appear');
    assert.ok(files.some((f) => f.includes('upgrade_failed_terminal_git_pull')),
      'FAIL-fallback kind should appear');
  });
});
