import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

/**
 * v1.17.83 — spool retry cap (in vin-windows-test round six, the DB log showed the same bad
 * record sent 6 times in a row, each a 500)
 *
 * Root cause: retrySpool sees a 5xx, writes the original line back to the spool, and retries next
 * time. If that payload is itself structurally broken (contains a null byte / the server always
 * rejects it), it forms an "infinite resend → consecutive 500s in the server log → wasted
 * bandwidth + DB warnings".
 *
 * Fix: each spool entry carries an `_attempts` counter, incremented by 1 on each failed retry;
 * once it reaches MAX_SPOOL_ATTEMPTS (=5) it is dropped and a warning is printed to stderr.
 * Already-uploaded entries are unaffected.
 */

describe('retrySpool — drop entries after MAX_SPOOL_ATTEMPTS (v1.17.83)', () => {
  let tmpDir, spoolDir, server, baseUrl;
  let serverFails = 0; // number of server rejections

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `ownmind-spool-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    spoolDir = tmpDir;
    fs.mkdirSync(spoolDir, { recursive: true });
    serverFails = 0;
    const app = express();
    app.use(express.json());
    app.post('/api/debug/install-check', (_req, res) => {
      // Always return 500, simulating "a bad payload that can never get through"
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
    // Re-import the module fresh (to avoid caching between tests)
    return await import('../scripts/install-helpers/self-check.cjs?cap=' + Math.random());
  }

  it('drops after 5 consecutive 5xx (reaches MAX_SPOOL_ATTEMPTS)', async () => {
    const { retrySpool, appendSpool } = await loadModule();
    appendSpool({ ts: '2026-05-08T17:00:00Z', trigger: 'install_started', machine: 'X' }, { spoolDir });

    // Run retry 5 times, each a 5xx; after the 5th the entry should disappear
    for (let i = 1; i <= 5; i += 1) {
      await retrySpool(baseUrl, 'fake-key', { spoolDir });
    }

    const spoolPath = path.join(spoolDir, '.upload-spool.jsonl');
    const remaining = fs.existsSync(spoolPath) ? fs.readFileSync(spoolPath, 'utf8').trim() : '';
    assert.equal(remaining, '', '達到 MAX_SPOOL_ATTEMPTS 後 entry 應該被丟掉');
  });

  it('entry below the cap is retained (attempt count increments correctly)', async () => {
    const { retrySpool, appendSpool } = await loadModule();
    appendSpool({ ts: '2026-05-08T17:00:00Z', trigger: 'install_started', machine: 'Y' }, { spoolDir });

    // Run 2 times (< 5) → entry still present, and _attempts should be 2
    await retrySpool(baseUrl, 'fake-key', { spoolDir });
    await retrySpool(baseUrl, 'fake-key', { spoolDir });

    const spoolPath = path.join(spoolDir, '.upload-spool.jsonl');
    const lines = fs.readFileSync(spoolPath, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const obj = JSON.parse(lines[0]);
    assert.equal(obj._attempts, 2, '_attempts 應該記錄已嘗試次數');
  });

  it('a successfully uploaded entry disappears after retry, regardless of count', async () => {
    // Switch server behavior: first request fails, then 200
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
