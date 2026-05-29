/**
 * v1.19.9 — scripts/reset-admin-password.js smoke test
 *
 * Corresponds to openspec/changes/v1.19.9-password-recovery/spec.md scenarios 9-12.
 *
 * A full e2e test (set up a fake DB, mock stdin, verify the UPDATE) is high-cost and low-value;
 * this layer only verifies:
 *   - --help exits 0 and prints usage
 *   - DB connection fails and exits 1 when env vars are missing
 *   - the script file exists and is runnable
 *
 * The real e2e is left to manual verification (before deploy).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(
  import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
  '..'
);
const scriptPath = path.join(repoRoot, 'scripts', 'reset-admin-password.js');

describe('v1.19.9 — reset-admin-password.js smoke', () => {
  it('script file exists', () => {
    assert.equal(fs.existsSync(scriptPath), true);
  });

  it('--help shows usage and exits 0', () => {
    const r = spawnSync('node', [scriptPath, '--help'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /emergency password recovery/i);
    assert.match(r.stdout, /DB_HOST|DB_USER/);
  });

  it('-h also triggers help', () => {
    const r = spawnSync('node', [scriptPath, '-h'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(r.status, 0);
  });

  it('exits 1 with a clear message when DB connection fails', () => {
    const r = spawnSync('node', [scriptPath], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        DB_HOST: '127.0.0.1',
        DB_PORT: '15432', // ensure it does not hit a local postgres
        DB_NAME: 'nonexistent_test_db',
        DB_USER: 'nonexistent_user',
        DB_PASSWORD: 'nope',
      },
    });
    assert.notEqual(r.status, 0, '應該失敗退出（非 0）');
    // message contains a keyword (Chinese "DB 連線失敗" or English ECONNREFUSED)
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.ok(
      /連線失敗|ECONNREFUSED|connect/i.test(combined),
      `應該提示連線失敗、實際輸出：${combined.slice(0, 200)}`
    );
  });
});
