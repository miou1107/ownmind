/**
 * v1.19.8 — Setup Wizard 單元測試
 *
 * 對應 openspec/changes/v1.19.8-setup-wizard/spec.md
 *   場景 4 ~ 10、14（route 層）
 *
 * 風格對齊 tests/admin-work-log.test.js：注入 fake query / withTransaction。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createSetupRouter, createFirstRunDetector } from '../src/routes/setup.js';

/**
 * 建一個 fake DB client、模擬 pg_advisory_xact_lock 跟基本 SQL 操作
 */
function makeFakeDb({ initialUsers = [], onInsertUser = null, throwAuditError = false } = {}) {
  let users = [...initialUsers];
  const queries = [];

  async function fakeQuery(text, params) {
    queries.push({ text, params });
    if (/SELECT COUNT\(\*\).*FROM users/i.test(text)) {
      const adminCount = users.filter((u) => u.role === 'admin' || u.role === 'super_admin').length;
      return { rows: [{ n: adminCount }] };
    }
    if (/pg_advisory_xact_lock/i.test(text)) {
      return { rows: [] };
    }
    if (/INSERT INTO users/i.test(text)) {
      if (onInsertUser) onInsertUser(params);
      const [name, email, apiKey, passwordHash] = params;
      // 模擬 unique violation
      if (users.find((u) => u.email === email)) {
        const e = new Error('duplicate key value violates unique constraint');
        e.code = '23505';
        throw e;
      }
      const newUser = {
        id: 'user-' + (users.length + 1),
        name,
        email,
        role: 'super_admin',
        api_key: apiKey,
        password_hash: passwordHash,
        created_at: new Date().toISOString(),
      };
      users.push(newUser);
      return { rows: [{ ...newUser, password_hash: undefined }] };
    }
    if (/INSERT INTO audit_logs/i.test(text)) {
      if (throwAuditError) throw new Error('audit_log table broken');
      return { rows: [] };
    }
    return { rows: [] };
  }

  async function withTransaction(fn) {
    const client = { query: fakeQuery };
    return await fn(client);
  }

  return { fakeQuery, withTransaction, getUsers: () => [...users], getQueries: () => queries };
}

function buildApp(deps) {
  const router = createSetupRouter(deps);
  const app = express();
  app.use(express.json());
  app.use('/api/setup', router);
  return app;
}

async function request(app, { method, path, body }) {
  return await new Promise((resolve) => {
    const req = {
      method,
      url: path,
      path,
      headers: { 'content-type': 'application/json' },
      body: body || {},
    };
    const res = {
      statusCode: 200,
      _body: null,
      setHeader() {},
      getHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(b) { this._body = b; resolve({ status: this.statusCode, body: b }); return this; },
      send(b) { this._body = b; resolve({ status: this.statusCode, body: b }); return this; },
      end(b) { this._body = b; resolve({ status: this.statusCode, body: b }); return this; },
    };
    app(req, res, (err) => err && resolve({ status: 500, body: { error: err.message } }));
  });
}

// ============================================================
// 場景 4：GET /status 回 first_run
// ============================================================

describe('v1.19.8 場景 4 — GET /api/setup/status', () => {
  it('users 表為空 → first_run=true、users_count=0', async () => {
    const db = makeFakeDb({ initialUsers: [] });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });
    const r = await request(app, { method: 'GET', path: '/api/setup/status' });
    assert.equal(r.status, 200);
    assert.equal(r.body.first_run, true);
    assert.equal(r.body.users_count, 0);
  });

  it('users 表已有 super_admin → first_run=false', async () => {
    const db = makeFakeDb({
      initialUsers: [{ id: 'u1', email: 'a@b.com', role: 'super_admin' }],
    });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });
    const r = await request(app, { method: 'GET', path: '/api/setup/status' });
    assert.equal(r.body.first_run, false);
    assert.equal(r.body.users_count, 1);
  });

  it('場景 14：users 有 super_admin 但 password_hash IS NULL → 仍視為 first_run=false', async () => {
    // first_run 判斷只看 role、不看 password_hash，
    // 所以舊 SETUP_TOKEN 流程的「待設定密碼」帳號也不會誤觸發 wizard
    const db = makeFakeDb({
      initialUsers: [{ id: 'u1', email: 'pending@b.com', role: 'super_admin', password_hash: null }],
    });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });
    const r = await request(app, { method: 'GET', path: '/api/setup/status' });
    assert.equal(r.body.first_run, false);
  });
});

// ============================================================
// 場景 5：POST /init 成功建第一個 super_admin
// ============================================================

describe('v1.19.8 場景 5 — POST /api/setup/init 成功路徑', () => {
  it('first_run + 正確輸入 → 建 super_admin、回 api_key', async () => {
    const db = makeFakeDb({ initialUsers: [] });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });

    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'admin@example.com', password: 'secure123', name: 'Vin' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.email, 'admin@example.com');
    assert.equal(r.body.role, 'super_admin');
    assert.equal(r.body.name, 'Vin');
    assert.ok(r.body.api_key, '應該回 api_key');
    // 不該洩漏密碼 hash
    assert.equal(r.body.password_hash, undefined);
  });

  it('建立成功會呼叫 advisory lock（race condition 防護）', async () => {
    const db = makeFakeDb({ initialUsers: [] });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });
    await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'a@b.com', password: 'secure123' },
    });
    const queries = db.getQueries();
    const hasAdvisoryLock = queries.some((q) => /pg_advisory_xact_lock/i.test(q.text));
    assert.equal(hasAdvisoryLock, true, '應該呼叫 pg_advisory_xact_lock');
  });

  it('建立成功會寫 audit_log（action=setup_init）', async () => {
    const db = makeFakeDb({ initialUsers: [] });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });
    await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'a@b.com', password: 'secure123' },
    });
    const queries = db.getQueries();
    const auditCall = queries.find((q) => /INSERT INTO audit_logs/i.test(q.text));
    assert.ok(auditCall, '應該寫 audit_log');
    assert.equal(auditCall.params[1], 'setup_init');
  });

  it('audit_log 寫入失敗不該擋 setup 成功', async () => {
    const db = makeFakeDb({ initialUsers: [], throwAuditError: true });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });
    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'a@b.com', password: 'secure123' },
    });
    assert.equal(r.status, 201, '即使 audit 失敗也該成功');
  });

  it('建立成功後 cache 立即 invalidate、第二次 status 直接看新狀態', async () => {
    const db = makeFakeDb({ initialUsers: [] });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });

    let r = await request(app, { method: 'GET', path: '/api/setup/status' });
    assert.equal(r.body.first_run, true);

    await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'a@b.com', password: 'secure123' },
    });

    r = await request(app, { method: 'GET', path: '/api/setup/status' });
    assert.equal(r.body.first_run, false, '建好後 status 應立即更新');
  });
});

// ============================================================
// 場景 6：first_run=false 時 init 被拒
// ============================================================

describe('v1.19.8 場景 6 — DB 已有 admin 時 POST /init 應拒絕', () => {
  it('回 403 + 訊息提示走 /admin/login', async () => {
    const db = makeFakeDb({
      initialUsers: [{ id: 'u1', email: 'existing@b.com', role: 'super_admin' }],
    });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    const app = buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector });

    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'new@b.com', password: 'secure123' },
    });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /setup wizard 已完成|admin\/login/);
  });
});

// ============================================================
// 場景 7/8/9：欄位驗證
// ============================================================

describe('v1.19.8 場景 7/8/9 — 欄位驗證', () => {
  function buildEmptyApp() {
    const db = makeFakeDb({ initialUsers: [] });
    const detector = createFirstRunDetector({ query: db.fakeQuery });
    return {
      app: buildApp({ query: db.fakeQuery, withTransaction: db.withTransaction, detector }),
      db,
    };
  }

  it('場景 7：密碼太短 → 400', async () => {
    const { app } = buildEmptyApp();
    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'a@b.com', password: 'short' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /至少 8/);
  });

  it('場景 8：email 格式不對 → 400', async () => {
    const { app } = buildEmptyApp();
    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'not-an-email', password: 'secure123' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /email/i);
  });

  it('場景 9：缺 password → 400', async () => {
    const { app } = buildEmptyApp();
    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'a@b.com' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /email|password|欄位/);
  });

  it('缺 email → 400', async () => {
    const { app } = buildEmptyApp();
    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { password: 'secure123' },
    });
    assert.equal(r.status, 400);
  });

  it('body 為 undefined → 400 不丟', async () => {
    const { app } = buildEmptyApp();
    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: undefined,
    });
    assert.equal(r.status, 400);
  });
});

// ============================================================
// 場景 10：race condition
// ============================================================

describe('v1.19.8 場景 10 — race condition 防護', () => {
  // v1.19.8 code-review I-3 註：
  //   這個測試驗證的是「post-lock COUNT recheck」這層防線（拿到鎖後再 SELECT、看到
  //   count > 0 就 ROLLBACK），不是直接驗證 pg_advisory_xact_lock 本身的序列化能力。
  //   要驗證真正的 advisory lock 需要 real Postgres 連線跟並發 transaction、
  //   屬於 integration test 範圍、留 future 用 PGHOST 環境變數 opt-in 的整合測試補。
  it('併發兩個 init：第一個拿到 lock 建成、第二個進 transaction 後 count > 0 → 403', async () => {
    // 模擬：第一次進 transaction 時 users 表空；中間有人插了一筆；第二次進 transaction 時 count > 0
    let userCount = 0;
    let advisoryLockCalls = 0;
    const fakeQuery = async (text) => {
      if (/SELECT COUNT/i.test(text)) {
        return { rows: [{ n: userCount }] };
      }
      if (/pg_advisory_xact_lock/i.test(text)) {
        advisoryLockCalls += 1;
        if (advisoryLockCalls === 1) {
          // 第一個 request 拿到 lock 後、模擬第二個 request 已經把 user 建好
          userCount = 1;
        }
        return { rows: [] };
      }
      if (/INSERT INTO users/i.test(text)) {
        return { rows: [{ id: 'u1', api_key: 'k', email: 'a@b.com', role: 'super_admin' }] };
      }
      if (/INSERT INTO audit_logs/i.test(text)) {
        return { rows: [] };
      }
      return { rows: [] };
    };
    const withTransaction = async (fn) => fn({ query: fakeQuery });
    const detector = createFirstRunDetector({ query: fakeQuery });
    const app = buildApp({ query: fakeQuery, withTransaction, detector });

    const r = await request(app, {
      method: 'POST',
      path: '/api/setup/init',
      body: { email: 'second@b.com', password: 'secure123' },
    });
    assert.equal(r.status, 403, '另一個 transaction 看到 count > 0、應該被擋');
  });
});

// ============================================================
// First-run cache 行為
// ============================================================

describe('v1.19.8 — first-run cache', () => {
  beforeEach(() => { /* 每個測試獨立 detector、不會共用 cache */ });

  it('first_run=false 的結果會被 cache、第二次呼叫不打 DB', async () => {
    let queryCalls = 0;
    const fakeQuery = async () => {
      queryCalls += 1;
      return { rows: [{ n: 1 }] };
    };
    const detector = createFirstRunDetector({ query: fakeQuery });
    await detector.detectFirstRun();
    await detector.detectFirstRun();
    assert.equal(queryCalls, 1, '第二次該走 cache、不打 DB');
  });

  it('first_run=true 不 cache、每次都重查（避免 race）', async () => {
    let queryCalls = 0;
    const fakeQuery = async () => {
      queryCalls += 1;
      return { rows: [{ n: 0 }] };
    };
    const detector = createFirstRunDetector({ query: fakeQuery });
    await detector.detectFirstRun();
    await detector.detectFirstRun();
    assert.equal(queryCalls, 2, 'first_run=true 不該 cache');
  });

  it('invalidate() 強制下次重查', async () => {
    let queryCalls = 0;
    let n = 1;
    const fakeQuery = async () => {
      queryCalls += 1;
      return { rows: [{ n }] };
    };
    const detector = createFirstRunDetector({ query: fakeQuery });
    await detector.detectFirstRun(); // 1
    await detector.detectFirstRun(); // cached
    detector.invalidate();
    await detector.detectFirstRun(); // 2
    assert.equal(queryCalls, 2);
  });

  it('DB 查詢失敗 → first_run=false（fail-open、不誤導使用者）', async () => {
    const fakeQuery = async () => { throw new Error('DB unreachable'); };
    const detector = createFirstRunDetector({
      query: fakeQuery,
      logger: { warn() {}, error() {} },
    });
    const r = await detector.detectFirstRun();
    assert.equal(r.firstRun, false);
    assert.equal(r.usersCount, -1);
  });
});
