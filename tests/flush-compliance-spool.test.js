import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/**
 * v1.17.97 — hooks/lib/flush-compliance-spool.js
 *
 * SessionStart hook 開頭呼叫的 helper：
 *   - 讀 ~/.ownmind/logs/reply-lint-pending.jsonl 整個檔
 *   - 一次 POST 到 /api/activity/batch（用 settings.json 的 OWNMIND_API_KEY/URL）
 *   - HTTP 200 → 刪掉 pending 檔（事件已落 DB）
 *   - 其他狀況 → 留著等下次再試
 *
 * 永不外漏到 stderr / stdout（IR-027 spec #3、SessionStart 跑 user 看得到的通道）。
 */

const repoRoot = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const helperPath = path.join(repoRoot, 'hooks', 'lib', 'flush-compliance-spool.js');

let tmpHome;
let pendingSpoolPath;

function setupTmpHome() {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-flush-spool-test-'));
  fs.mkdirSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true });
  pendingSpoolPath = path.join(tmpHome, '.ownmind', 'logs', 'reply-lint-pending.jsonl');
}
function cleanupTmpHome() { fs.rmSync(tmpHome, { recursive: true, force: true }); }

function setupCredentials(apiUrl) {
  const claudeDir = path.join(tmpHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    mcpServers: { ownmind: { env: { OWNMIND_API_KEY: 'test-key', OWNMIND_API_URL: apiUrl } } },
  }));
}

function makeEvent(rule = 'IR-037', message = 'mixed lang') {
  return {
    ts: new Date().toISOString(),
    event: 'iron_rule_compliance',
    tool: 'claude-code',
    source: 'reply-lint-hook',
    details: { action: 'violate', rule_code: rule, message },
  };
}

function seedPending(events) {
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(pendingSpoolPath, lines);
}

function runHelper(env = {}) {
  return spawnSync('node', [helperPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      ...env,
    },
  });
}

/** Async 版 — fake server 跟 helper 同 Node process 時要用這個 */
function runHelperAsync(env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [helperPath], {
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        ...env,
      },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => resolve({ status: code, stdout, stderr }));
  });
}

function startFakeServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => handler({ method: req.method, url: req.url, body, headers: req.headers }, res));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

describe('v1.17.97 — flush-compliance-spool helper 基本契約', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('helper 檔案存在 + 可被 node spawn', () => {
    assert.ok(fs.existsSync(helperPath));
    const r = runHelper();
    assert.equal(r.status, 0);
  });

  it('pending 檔不存在 → 直接 exit 0、stderr/stdout 空白', () => {
    setupCredentials('http://127.0.0.1:1');
    const r = runHelper();
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '', 'stderr 必須空白');
    assert.equal(r.stdout, '', 'stdout 必須空白');
  });

  it('pending 檔存在但空 → 不 POST、不 crash', () => {
    fs.writeFileSync(pendingSpoolPath, '');
    setupCredentials('http://127.0.0.1:1');
    const r = runHelper();
    assert.equal(r.status, 0);
  });

  it('沒設 credentials → 留著 pending 檔不動', () => {
    seedPending([makeEvent()]);
    const r = runHelper();
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(pendingSpoolPath), '沒 credentials 時不該刪 pending 檔');
  });
});

describe('v1.17.97 — POST 行為', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('POST 200 → 刪掉 pending 檔', async () => {
    let captured = null;
    const server = await startFakeServer((req, res) => {
      captured = req;
      res.statusCode = 200; res.end('{"inserted":2}');
    });
    try {
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      setupCredentials(apiUrl);
      seedPending([makeEvent('IR-037'), makeEvent('IR-036')]);
      const r = await runHelperAsync();
      assert.equal(r.status, 0);
      assert.equal(r.stderr, '');
      assert.ok(captured, '應該打 POST');
      assert.equal(captured.method, 'POST');
      assert.equal(captured.url, '/api/activity/batch');
      const body = JSON.parse(captured.body);
      assert.equal(body.events.length, 2);
      assert.equal(fs.existsSync(pendingSpoolPath), false,
        'POST 200 後必須刪 pending 檔（避免下次又送一次）');
    } finally { server.close(); }
  });

  it('POST 5xx → 留著 pending 檔等下次重試', async () => {
    const server = await startFakeServer((req, res) => {
      res.statusCode = 500; res.end('boom');
    });
    try {
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      setupCredentials(apiUrl);
      seedPending([makeEvent()]);
      const r = await runHelperAsync();
      assert.equal(r.status, 0);
      assert.ok(fs.existsSync(pendingSpoolPath),
        '5xx 不算成功 → pending 檔保留');
    } finally { server.close(); }
  });

  it('POST 連線錯誤 → 留著 pending 檔', () => {
    setupCredentials('http://127.0.0.1:1');  // 沒人 listen
    seedPending([makeEvent()]);
    const r = runHelper();
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(pendingSpoolPath));
  });

  it('壞行（不可解 JSON）跳過、好行繼續送', async () => {
    let captured = null;
    const server = await startFakeServer((req, res) => {
      captured = req;
      res.statusCode = 200; res.end('{"inserted":1}');
    });
    try {
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      setupCredentials(apiUrl);
      // 一行壞、一行好
      fs.writeFileSync(pendingSpoolPath,
        'this is not json\n' +
        JSON.stringify(makeEvent()) + '\n');
      const r = await runHelperAsync();
      assert.equal(r.status, 0);
      assert.ok(captured, 'POST 仍該送');
      const body = JSON.parse(captured.body);
      assert.equal(body.events.length, 1, '只送可 parse 的那行');
      assert.equal(fs.existsSync(pendingSpoolPath), false);
    } finally { server.close(); }
  });

  it('全部都壞行 → 不 POST、刪 pending 檔（沒救的資料、不要永遠卡著）', () => {
    setupCredentials('http://127.0.0.1:1');
    fs.writeFileSync(pendingSpoolPath, 'broken1\nbroken2\n');
    const r = runHelper();
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingSpoolPath), false,
      '全壞 → 直接刪掉、避免每次 SessionStart 都重試一個永遠送不出去的檔');
  });

  it('Auth header + Content-Type 對齊 server 期望', async () => {
    let captured = null;
    const server = await startFakeServer((req, res) => {
      captured = req;
      res.statusCode = 200; res.end('{"inserted":1}');
    });
    try {
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      setupCredentials(apiUrl);
      seedPending([makeEvent()]);
      await runHelperAsync();
      assert.match(captured.headers['authorization'], /^Bearer test-key$/);
      assert.match(captured.headers['content-type'], /application\/json/);
    } finally { server.close(); }
  });
});

// review-I2 fix：rename → POST → unlink，read-then-delete race 收窄
describe('v1.17.97 review-I2 — rename-then-process race 收窄', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('POST 成功 — processing 檔不該殘留、pending 檔被消耗', async () => {
    const server = await startFakeServer((req, res) => { res.statusCode = 200; res.end('{}'); });
    try {
      setupCredentials(`http://127.0.0.1:${server.address().port}`);
      seedPending([makeEvent()]);
      await runHelperAsync();
      assert.equal(fs.existsSync(pendingSpoolPath), false, 'pending 應被消耗');
      // 不該有 .processing-* 殘留
      const orphans = fs.readdirSync(path.join(tmpHome, '.ownmind', 'logs'))
        .filter(f => f.includes('.processing-'));
      assert.equal(orphans.length, 0, 'processing 檔不該殘留：' + orphans.join(','));
    } finally { server.close(); }
  });

  it('POST 失敗 — processing 還原成 pending、不丟資料', () => {
    setupCredentials('http://127.0.0.1:1');
    const ev = makeEvent('IR-037', 'must-survive');
    seedPending([ev]);
    runHelper();
    assert.ok(fs.existsSync(pendingSpoolPath), 'POST 失敗 → pending 該被還原');
    const lines = fs.readFileSync(pendingSpoolPath, 'utf8').trim().split('\n');
    const recovered = JSON.parse(lines[0]);
    assert.equal(recovered.details.message, 'must-survive', '原事件必須完好還原');
    // 不該有 .processing 檔殘留
    const orphans = fs.readdirSync(path.join(tmpHome, '.ownmind', 'logs'))
      .filter(f => f.includes('.processing-'));
    assert.equal(orphans.length, 0);
  });

  it('沒 credentials — processing 還原成 pending（user 還在配 OwnMind 的場景）', () => {
    // 不呼叫 setupCredentials → readCredentialsInline 回空字串
    const ev = makeEvent('IR-037', 'wait-for-creds');
    seedPending([ev]);
    runHelper();
    assert.ok(fs.existsSync(pendingSpoolPath),
      '沒 credentials 不該丟資料、要還原 pending');
    const recovered = JSON.parse(fs.readFileSync(pendingSpoolPath, 'utf8').trim().split('\n')[0]);
    assert.equal(recovered.details.message, 'wait-for-creds');
  });

  it('PENDING_FILE 不存在 — exit 0、不嘗試 rename', () => {
    setupCredentials('http://127.0.0.1:1');
    // 不 seed
    const r = runHelper();
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });
});

describe('v1.17.97 — 嚴格契約：絕不污染 stdout / stderr', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('成功 / 失敗 / 沒檔 / 沒 credentials — stdout 與 stderr 都必須完全空白', async () => {
    const okServer = await startFakeServer((req, res) => { res.statusCode = 200; res.end('{}'); });
    try {
      const okUrl = `http://127.0.0.1:${okServer.address().port}`;
      const cases = [
        { name: '無檔案', setup: () => setupCredentials(okUrl), env: {} },
        { name: '無 credentials', setup: () => seedPending([makeEvent()]), env: {} },
        { name: 'POST 成功', setup: () => { setupCredentials(okUrl); seedPending([makeEvent()]); }, env: {} },
        { name: 'POST 連線失敗', setup: () => { setupCredentials('http://127.0.0.1:1'); seedPending([makeEvent()]); }, env: {} },
      ];
      for (const c of cases) {
        cleanupTmpHome(); setupTmpHome();
        c.setup();
        const r = await runHelperAsync(c.env);
        assert.equal(r.stdout, '', `[${c.name}] stdout 必須空白：${JSON.stringify(r.stdout)}`);
        assert.equal(r.stderr, '', `[${c.name}] stderr 必須空白：${JSON.stringify(r.stderr)}`);
        assert.equal(r.status, 0);
      }
    } finally { okServer.close(); }
  });
});
