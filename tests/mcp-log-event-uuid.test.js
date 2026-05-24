import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/**
 * v1.17.99 — mcp/ownmind-log.js logEvent 必須給每筆事件生 client_event_id
 *
 * 為什麼：
 *   v1.17.98 server 端用 (user_id, client_event_id) partial unique index dedup。
 *   v1.17.96/97 reply-lint hook 已經帶 id、但 mcp/ownmind-log.js logEvent 沒帶 →
 *   server 對 logEvent 走 NULL path、夠用但沒 dedup 保護。
 *
 *   v1.17.99 給 logEvent 也加 client_event_id、跨所有 client path 一致 dedup。
 *
 * 注意：mcp/ownmind-log.js 用 fetch（node-fetch）打 server、用環境變數注入 API_URL/KEY、
 * buffer 邏輯複雜（10 events / 30s / IMMEDIATE_FLUSH_EVENTS 三種觸發）。
 * 這裡只驗 logEvent 寫進 JSONL 的 entry 跟 POST body 的 events 都帶 UUID v4。
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let tmpHome;
let logsDir;
let captured;
let fakeServer;
let serverPort;

async function startFakeServer() {
  return new Promise((resolve) => {
    fakeServer = http.createServer((req, res) => {
      let buf = '';
      req.on('data', c => buf += c);
      req.on('end', () => {
        try { captured.push(JSON.parse(buf)); } catch { captured.push({ _raw: buf }); }
        res.statusCode = 200; res.end('{"inserted":0,"deduped":0,"total":0,"auto_observed":0}');
      });
    });
    fakeServer.listen(0, '127.0.0.1', () => {
      serverPort = fakeServer.address().port;
      resolve();
    });
  });
}

function setup() {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-log-uuid-test-'));
  logsDir = path.join(tmpHome, '.ownmind', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  captured = [];
}

function cleanup() {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  // I2 — 每次 cachebust import 都會 register 新的 process.on('beforeExit'/'SIGINT'/'SIGTERM')
  // listener、避免累積到 MaxListenersExceededWarning。test 結束清掉這次新增的。
  // 注意：不清乾淨的話會在 process exit 時觸發多次 fetch（雖然 fakeServer 已關、就是 silent fail）
  for (const sig of ['beforeExit', 'SIGINT', 'SIGTERM']) {
    process.removeAllListeners(sig);
  }
}

/**
 * I4 — setTimeout flaky 替代：poll captured.length 直到 >= n 或 timeout
 */
async function waitForPosts(n, timeoutMs = 2000) {
  const start = Date.now();
  while (captured.length < n) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等 ${n} 個 POST 超時、實際 ${captured.length}`);
    }
    await new Promise(r => setTimeout(r, 10));
  }
}

async function freshLogModule(env = {}) {
  // 強迫 re-import 以套用最新 env
  const mod = await import(`../mcp/ownmind-log.js?cachebust=${Date.now()}-${Math.random()}`);
  return mod;
}

// 從 ownmind-log.js export 的同一份邏輯 — 兩處用同源避免時區飄移
const { localDateOnly } = await import('../mcp/ownmind-log.js');

describe('v1.17.99 — mcp/ownmind-log.js logEvent 帶 client_event_id', () => {
  beforeEach(async () => {
    setup();
    await startFakeServer();
    // logEvent 從 process.env 讀 HOME / API_URL / API_KEY、import 時就 freeze
    process.env.HOME = tmpHome;
    process.env.OWNMIND_API_URL = `http://127.0.0.1:${serverPort}`;
    process.env.OWNMIND_API_KEY = 'fake-key';
    // I3 — hygiene：清掉開發機殘留的 OWNMIND_TOOL（不然第一筆 entry 會洩漏）
    process.env.OWNMIND_TOOL = 'test-claude-code';
  });
  afterEach(() => {
    fakeServer?.close();
    cleanup();
  });

  it('每筆寫進本地 JSONL 的 entry 都帶 UUID v4 client_event_id', async () => {
    const { logEvent } = await freshLogModule();
    logEvent('memory_save', { rule_code: 'IR-001' });
    logEvent('memory_disable', { rule_code: 'IR-002' });

    // 等本地 JSONL 寫完（appendFileSync 同步）
    // 跟 logEvent 對齊用 local-time date（IR-032 時區政策、避免跨午夜 UTC vs
    // 台北 8h 差讓 test 找錯檔名）
    const today = localDateOnly(new Date());
    const file = path.join(logsDir, `${today}.jsonl`);
    assert.ok(fs.existsSync(file));
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const ids = lines.map(l => JSON.parse(l).client_event_id);
    assert.ok(ids[0], 'event 1 必須有 client_event_id');
    assert.ok(ids[1], 'event 2 必須有 client_event_id');
    assert.match(ids[0], UUID_V4);
    assert.match(ids[1], UUID_V4);
    assert.notEqual(ids[0], ids[1], '兩筆事件必須不同 id（randomUUID 每次新生）');
  });

  it('POST 到 server 的 events array 也帶 client_event_id（buffer flush 不能吃掉）', async () => {
    const { logEvent } = await freshLogModule();
    // iron_rule_compliance 在 IMMEDIATE_FLUSH_EVENTS 內、會立刻 POST
    logEvent('iron_rule_compliance', { action: 'violate', rule_code: 'IR-037' });
    // 等 fetch 完成
    await waitForPosts(1);
    assert.ok(captured.length >= 1, 'server 應收到 POST');
    const body = captured[0];
    assert.ok(Array.isArray(body.events));
    assert.equal(body.events.length, 1);
    assert.ok(body.events[0].client_event_id, 'POST body event 必須帶 client_event_id');
    assert.match(body.events[0].client_event_id, UUID_V4);
  });

  it('JSONL entry 的 id 跟 POST body 的 id 必須相同（同一份 entry 物件共用）', async () => {
    const { logEvent } = await freshLogModule();
    logEvent('iron_rule_compliance', { action: 'violate', rule_code: 'IR-036' });
    await waitForPosts(1);

    // 跟 logEvent 對齊用 local-time date（IR-032 時區政策、避免跨午夜 UTC vs
    // 台北 8h 差讓 test 找錯檔名）
    const today = localDateOnly(new Date());
    const file = path.join(logsDir, `${today}.jsonl`);
    const localEntry = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n')[0]);
    const postedEvent = captured[0]?.events?.[0];

    assert.ok(localEntry.client_event_id);
    assert.ok(postedEvent?.client_event_id);
    assert.equal(localEntry.client_event_id, postedEvent.client_event_id,
      '本地 JSONL 跟 POST body 必須帶同 id（dedup 才有意義）');
  });
});
