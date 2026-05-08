import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

/**
 * v1.17.83 — spool retry cap（vin-windows-test 第六輪 DB log 看到同筆壞資料連送 6 次 500）
 *
 * Root cause：retrySpool 看到 5xx 把原 line 寫回 spool，下次再試。如果該筆 payload 本身
 * 結構性壞掉（含 null byte / server 永遠拒絕），就形成「無限重送 → server log 連續 500
 * → bandwidth + DB warning 浪費」。
 *
 * 修法：每筆 spool entry 帶 `_attempts` 計數，retry 失敗加 1；達到 MAX_SPOOL_ATTEMPTS
 * (=5) 直接 drop + stderr 印 warning。已上傳的 entry 不影響。
 */

describe('retrySpool — drop entries after MAX_SPOOL_ATTEMPTS (v1.17.83)', () => {
  let tmpDir, spoolDir, server, baseUrl;
  let serverFails = 0; // server 拒絕次數

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `ownmind-spool-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    spoolDir = tmpDir;
    fs.mkdirSync(spoolDir, { recursive: true });
    serverFails = 0;
    const app = express();
    app.use(express.json());
    app.post('/api/debug/install-check', (_req, res) => {
      // 永遠回 500，模擬「壞 payload 怎麼送都進不去」
      serverFails += 1;
      res.status(500).json({ error: 'unsupported Unicode escape sequence' });
    });
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function loadModule() {
    // 重新 import 拿模組（避免測試之間 cache）
    return await import('../scripts/install-helpers/self-check.cjs?cap=' + Math.random());
  }

  it('連續 5 次 5xx 後 drop（達到 MAX_SPOOL_ATTEMPTS）', async () => {
    const { retrySpool, appendSpool } = await loadModule();
    appendSpool({ ts: '2026-05-08T17:00:00Z', trigger: 'install_started', machine: 'X' }, { spoolDir });

    // 跑 5 次 retry，每次都 5xx；第 5 次後 entry 應消失
    for (let i = 1; i <= 5; i += 1) {
      await retrySpool(baseUrl, 'fake-key', { spoolDir });
    }

    const spoolPath = path.join(spoolDir, '.upload-spool.jsonl');
    const remaining = fs.existsSync(spoolPath) ? fs.readFileSync(spoolPath, 'utf8').trim() : '';
    assert.equal(remaining, '', '達到 MAX_SPOOL_ATTEMPTS 後 entry 應該被丟掉');
  });

  it('未達上限的 entry 仍保留（attempt 計數正確 increment）', async () => {
    const { retrySpool, appendSpool } = await loadModule();
    appendSpool({ ts: '2026-05-08T17:00:00Z', trigger: 'install_started', machine: 'Y' }, { spoolDir });

    // 跑 2 次（< 5）→ entry 還在，且 _attempts 應該 = 2
    await retrySpool(baseUrl, 'fake-key', { spoolDir });
    await retrySpool(baseUrl, 'fake-key', { spoolDir });

    const spoolPath = path.join(spoolDir, '.upload-spool.jsonl');
    const lines = fs.readFileSync(spoolPath, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const obj = JSON.parse(lines[0]);
    assert.equal(obj._attempts, 2, '_attempts 應該記錄已嘗試次數');
  });

  it('成功上傳的 entry 在 retry 後消失，與計數無關', async () => {
    // 切換 server 行為：第 1 次失敗，之後 200
    let serverHits = 0;
    await new Promise((r) => server.close(r));
    const app = express();
    app.use(express.json());
    app.post('/api/debug/install-check', (_req, res) => {
      serverHits += 1;
      if (serverHits === 1) return res.status(500).json({ error: 'fail' });
      return res.json({ ok: true });
    });
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    const { retrySpool, appendSpool } = await loadModule();
    appendSpool({ ts: '2026-05-08T17:00:00Z', trigger: 'install_started', machine: 'Z' }, { spoolDir });

    await retrySpool(baseUrl, 'fake-key', { spoolDir }); // 1st: fail, _attempts=1
    await retrySpool(baseUrl, 'fake-key', { spoolDir }); // 2nd: success → drop

    const spoolPath = path.join(spoolDir, '.upload-spool.jsonl');
    const remaining = fs.existsSync(spoolPath) ? fs.readFileSync(spoolPath, 'utf8').trim() : '';
    assert.equal(remaining, '', '上傳成功後 entry 應該消失');
  });
});
