import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.79 — 統一錯誤回報機制 + dirty tree 自動處理（IR-038, 回報者 vin-windows-test 第三輪）
 *
 * Root cause：
 *   - install / upgrade 中段任何 fatal error 都 exit 1，end-of-file self-check 跑不到 → admin 看不到根因
 *   - vin-windows-test 案例：他的 AI 編輯了 mcp/start.cmd 沒 commit，下次 git pull --ff-only 直接拒絕
 *     → upgrade fail，user 卡住，server 完全沒紀錄
 *   - 整個 client 端缺一個「失敗就自動回報」的統一機制
 *
 * 修法（兩件事）：
 *   1. errors/ spool 機制：所有失敗點 drop JSON 到 ~/.ownmind/logs/errors/
 *      self-check drainErrorSpool() 統一上傳到 /api/debug/install-check (v1.17.78 已放寬)
 *   2. interactive-upgrade.{sh,ps1}：偵測 dirty working tree → drop error report → git reset --hard origin/main → 繼續升級
 */

describe('report-error.cjs helper（寫 errors/ spool 檔）', () => {
  const tmpHome = path.join(os.tmpdir(), `ownmind-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const errorsDir = path.join(tmpHome, '.ownmind', 'logs', 'errors');
  const helper = path.join(repoRoot, 'scripts/install-helpers/report-error.cjs');

  beforeEach(() => {
    fs.mkdirSync(errorsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('helper 寫出 <ts>-<kind>.json 檔到 errors/ 目錄', () => {
    execFileSync('node', [
      helper,
      '--kind=upgrade_dirty_tree',
      '--detail=mcp/start.cmd has uncommitted changes',
    ], { env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome } });

    const files = fs.readdirSync(errorsDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d+-upgrade_dirty_tree\.json$/);

    const obj = JSON.parse(fs.readFileSync(path.join(errorsDir, files[0]), 'utf8'));
    assert.equal(obj.kind, 'upgrade_dirty_tree');
    assert.equal(obj.detail, 'mcp/start.cmd has uncommitted changes');
    assert.ok(obj.ts);
  });

  it('detail 帶特殊字元（換行、引號）也能安全寫入', () => {
    execFileSync('node', [
      helper,
      '--kind=npm_fail',
      '--detail=line1\nline2 with "quotes" and \\backslash',
    ], { env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome } });

    const files = fs.readdirSync(errorsDir);
    const obj = JSON.parse(fs.readFileSync(path.join(errorsDir, files[0]), 'utf8'));
    assert.equal(obj.detail, 'line1\nline2 with "quotes" and \\backslash');
  });

  it('--context-file 帶 log 檔時，檔尾 30 行進 context 欄位（HOME 路徑去掉）', () => {
    const logFile = path.join(tmpHome, 'fake.log');
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${tmpHome}/some/path`);
    fs.writeFileSync(logFile, lines.join('\n'));

    execFileSync('node', [
      helper,
      '--kind=git_pull_failed',
      '--detail=conflict',
      `--context-file=${logFile}`,
    ], { env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome } });

    const files = fs.readdirSync(errorsDir);
    const obj = JSON.parse(fs.readFileSync(path.join(errorsDir, files[0]), 'utf8'));
    assert.ok(obj.context.includes('line 49'), 'context 必須包含 log 尾行');
    assert.ok(!obj.context.includes(tmpHome), `HOME 路徑應 sanitize 成 ~：context=${obj.context.slice(0, 200)}`);
  });
});

describe('drainErrorSpool — self-check 把 errors/ 的檔案上傳並刪除', () => {
  let tmpHome;
  let errorsDir;
  const fakeServer = { received: [], status: 200 };

  beforeEach(async () => {
    tmpHome = path.join(os.tmpdir(), `ownmind-drain-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    errorsDir = path.join(tmpHome, '.ownmind', 'logs', 'errors');
    fs.mkdirSync(errorsDir, { recursive: true });
    fakeServer.received = [];
    fakeServer.status = 200;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  async function withServer(handler, fn) {
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.post('/api/debug/install-check', handler);
    return new Promise((resolve, reject) => {
      const server = app.listen(0, async () => {
        const url = `http://127.0.0.1:${server.address().port}`;
        try {
          const result = await fn(url);
          server.close(() => resolve(result));
        } catch (e) {
          server.close(() => reject(e));
        }
      });
    });
  }

  it('讀完 errors/*.json 一一上傳，成功就刪檔', async () => {
    fs.writeFileSync(path.join(errorsDir, '1700000001-foo.json'),
      JSON.stringify({ ts: '2026-05-08T17:00:00Z', kind: 'foo', detail: 'd1' }));
    fs.writeFileSync(path.join(errorsDir, '1700000002-bar.json'),
      JSON.stringify({ ts: '2026-05-08T17:00:01Z', kind: 'bar', detail: 'd2' }));

    const { drainErrorSpool } = await import('../scripts/install-helpers/self-check.cjs');

    await withServer((req, res) => {
      fakeServer.received.push(req.body);
      res.json({ ok: true });
    }, async (url) => {
      const result = await drainErrorSpool(url, 'fake-key', { errorsDir });
      assert.equal(result.uploaded, 2);
      assert.equal(result.failed, 0);
    });

    assert.equal(fakeServer.received.length, 2);
    const triggers = fakeServer.received.map((r) => r.trigger).sort();
    assert.deepEqual(triggers, ['error_bar', 'error_foo']);
    assert.equal(fs.readdirSync(errorsDir).length, 0, '上傳成功的檔案應已刪除');
  });

  it('上傳失敗（5xx）保留檔案下次再試', async () => {
    fs.writeFileSync(path.join(errorsDir, '1700000003-keep.json'),
      JSON.stringify({ ts: '2026-05-08T17:00:00Z', kind: 'keep', detail: 'd' }));

    const { drainErrorSpool } = await import('../scripts/install-helpers/self-check.cjs');

    await withServer((_req, res) => res.status(500).json({ error: 'fail' }), async (url) => {
      const result = await drainErrorSpool(url, 'fake-key', { errorsDir });
      assert.equal(result.uploaded, 0);
      assert.equal(result.failed, 1);
    });

    assert.equal(fs.readdirSync(errorsDir).length, 1, '上傳失敗檔案應保留');
  });

  it('沒 apiUrl/apiKey 時 skip 不爆，retain 全部檔案', async () => {
    fs.writeFileSync(path.join(errorsDir, '1700000004-x.json'),
      JSON.stringify({ ts: '2026-05-08T17:00:00Z', kind: 'x', detail: 'd' }));

    const { drainErrorSpool } = await import('../scripts/install-helpers/self-check.cjs');
    const result = await drainErrorSpool(null, null, { errorsDir });
    assert.equal(result.skipped, 'no_credentials');
    assert.equal(fs.readdirSync(errorsDir).length, 1);
  });

  it('errors/ 不存在不爆，回 0', async () => {
    fs.rmSync(errorsDir, { recursive: true, force: true });
    const { drainErrorSpool } = await import('../scripts/install-helpers/self-check.cjs');
    const result = await drainErrorSpool('http://x', 'k', { errorsDir });
    assert.equal(result.uploaded, 0);
    assert.equal(result.failed, 0);
  });
});

describe('interactive-upgrade.sh — dirty tree auto-recover', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/interactive-upgrade.sh'), 'utf8');

  it('偵測 git status --porcelain 非空（dirty tree）', () => {
    assert.match(content, /git status --porcelain/);
  });

  it('dirty 時送 upgrade_dirty_tree error report', () => {
    assert.match(content, /upgrade_dirty_tree/);
  });

  it('dirty 時用 git fetch + git reset --hard origin/main 強制對齊（backup 保險絲已先做）', () => {
    assert.match(content, /git\s+fetch/);
    assert.match(content, /git\s+reset\s+--hard\s+origin\/main/);
  });
});

describe('interactive-upgrade.ps1 — dirty tree auto-recover (Windows)', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/interactive-upgrade.ps1'), 'utf8');

  it('偵測 git status --porcelain 非空', () => {
    assert.match(content, /git\s+status\s+--porcelain/);
  });

  it('dirty 時送 upgrade_dirty_tree error report', () => {
    assert.match(content, /upgrade_dirty_tree/);
  });

  it('dirty 時 git fetch + reset --hard origin/main', () => {
    assert.match(content, /git\s+fetch/);
    assert.match(content, /git\s+reset\s+--hard\s+origin\/main/);
  });
});

describe('mcp/start.cmd — 找不到 node 時寫 errors/ spool 檔', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'mcp/start.cmd'), 'utf8');

  it('包含寫 errors/ 目錄的 echo 指令（cmd 把 plain text 寫到 .txt）', () => {
    // start.cmd 找不到 node 時，把錯誤資訊 echo 到 errors\<random>-mcp_start_no_node.txt
    assert.match(content, /errors\\/i, 'cmd 必須 redirect 到 logs\\errors\\ 目錄');
    assert.match(content, /mcp_start_no_node/, 'kind 必須是 mcp_start_no_node');
  });
});
