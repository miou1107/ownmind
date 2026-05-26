/**
 * v1.19.9 — scripts/reset-admin-password.js smoke 測試
 *
 * 對應 openspec/changes/v1.19.9-password-recovery/spec.md 場景 9-12。
 *
 * 完整 e2e 測試（建假 DB、模擬 stdin、驗 UPDATE）成本高、價值低；
 * 這層只驗：
 *   - --help 退出碼 0、印出說明
 *   - 沒環境變數時 DB 連線失敗、退出碼 1
 *   - 腳本檔存在、可跑
 *
 * 真正的 e2e 留手動驗證（部署前）。
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
  it('腳本檔存在', () => {
    assert.equal(fs.existsSync(scriptPath), true);
  });

  it('--help 顯示說明、退出碼 0', () => {
    const r = spawnSync('node', [scriptPath, '--help'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /emergency password recovery/i);
    assert.match(r.stdout, /DB_HOST|DB_USER/);
  });

  it('-h 也走 help', () => {
    const r = spawnSync('node', [scriptPath, '-h'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(r.status, 0);
  });

  it('DB 連線失敗時退出碼 1、訊息明確', () => {
    const r = spawnSync('node', [scriptPath], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        DB_HOST: '127.0.0.1',
        DB_PORT: '15432', // 確保不會撞到本機 postgres
        DB_NAME: 'nonexistent_test_db',
        DB_USER: 'nonexistent_user',
        DB_PASSWORD: 'nope',
      },
    });
    assert.notEqual(r.status, 0, '應該失敗退出（非 0）');
    // 訊息含關鍵字（中文「DB 連線失敗」或英文 ECONNREFUSED）
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.ok(
      /連線失敗|ECONNREFUSED|connect/i.test(combined),
      `應該提示連線失敗、實際輸出：${combined.slice(0, 200)}`
    );
  });
});
