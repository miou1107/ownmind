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
 * v1.17.78 — install_started beacon 觀測管道（IR-038, 回報者 vin-windows-test）
 *
 * Root cause：v1.17.77 之前 install_check_logs.user_id=8 整個 0 row。
 * 排查後 root cause = install.ps1 中段 npm install 被 ExecutionPolicy 擋住 exit 1，
 * end-of-file 的 self-check.cjs 永遠跑不到 → admin 看不到「user 試過安裝」。
 * v1.17.76 修了 ExecutionPolicy，但中段任何其他失敗（winget 失敗、git clone 失敗
 * 等）一樣會 exit 1 → 同樣盲點。
 *
 * 結構性修法：install.ps1 / install.sh 在 API key 確認後立刻送 install_started
 * beacon。要送出的話 server endpoint 必須接受沒有 checks/summary 的 minimal body。
 */

describe('debug route — install-check 接受 minimal beacon (v1.17.78)', () => {
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
    app.use('/api/debug', createDebugRouter({ query: makeQuery(), auth: makeAuth(8) }));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}/api/debug/install-check`;
        resolve();
      });
    });
  });

  // 每個 it 結束後關 server，否則 node --test 整支不退出
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

  it('beacon 只帶 ts + trigger 也接受（沒 checks / summary）', async () => {
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

  it('完整 self-check report 仍照常接受（向後相容）', async () => {
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

  it('沒 ts 仍 reject（只有 ts 是強制）', async () => {
    const r = await post({ trigger: 'install_started' });
    assert.equal(r.status, 400);
  });

  it('checks 給了但不是 array 仍 reject', async () => {
    const r = await post({ ts: '2026-05-08T17:00:00Z', checks: 'oops' });
    assert.equal(r.status, 400);
  });

  it('checks[*].status 不合法仍 reject', async () => {
    const r = await post({
      ts: '2026-05-08T17:00:00Z',
      checks: [{ name: 'x', status: 'whatever' }],
      summary: {},
    });
    assert.equal(r.status, 400);
  });
});

describe('install scripts — 一定要送 install_started beacon (v1.17.78)', () => {
  it('install.ps1 內含 Send-InstallBeacon 呼叫', () => {
    const content = fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8');
    assert.match(content, /Send-InstallBeacon/);
    assert.match(content, /install_started/);
    assert.match(content, /\/api\/debug\/install-check/);
  });

  it('install.sh 內含 send_install_beacon 呼叫', () => {
    const content = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
    assert.match(content, /send_install_beacon/);
    assert.match(content, /install_started/);
    assert.match(content, /\/api\/debug\/install-check/);
  });
});

