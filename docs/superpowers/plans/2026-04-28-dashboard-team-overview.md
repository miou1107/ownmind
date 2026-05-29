# Dashboard 團隊一覽改造 — Implementation Plan (v1.17.17)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-04-28-dashboard-team-overview-design.md` (commit `5f8cdef`)

**Goal:** 把現有「團隊用量」分頁擴充為完整成績單（含最近活動、對話場次、最常做的專案、鐵律遵守率），點開成員後可看「最近對話」流水帳；「Audit Log」改名「資料品質警示」。

**Architecture:** 後端新增 `src/routes/usage/team-overview.js`（純讀，不動 schema），暴露兩支 admin API；前端 `src/public/index.html` 的 team-usage tab 局部改造，沿用現有 `loadTeamUsage()` / `loadMemberDetail()` 的擴充點。資料來源 `session_logs` 表已存在。

**Tech Stack:** Node 20 / Express 4 / PostgreSQL（pg）/ node:test / vanilla JS（無 framework）

---

## File Structure

**Create:**
- `src/routes/usage/team-overview.js` — admin API（scoreboard + sessions timeline）
- `tests/team-overview-api.test.js` — scoreboard endpoint 單元測試
- `tests/team-overview-sessions-api.test.js` — sessions endpoint 單元測試

**Modify:**
- `src/routes/usage/index.js` — mount 新 router 在 `/admin/team-overview`
- `src/public/index.html` — 表格擴欄、預設 7 天、新增「最近對話」區塊、改名「資料品質警示」
- `package.json` — version 1.17.16 → 1.17.17（CLIENT_VERSION / SERVER_VERSION 都動態讀此檔）
- `README.md` / `README.en.md` / `README.ja.md` — IR-032 三語系同步版號（如有版號標記）
- `FILELIST.md` — 加新檔
- `CHANGELOG.md` — 加 v1.17.17 entry

**No schema migration.** session_logs / users / usage_metrics_daily 都已存在。

---

## Phase 1：後端 — Scoreboard API

### Task 1: 鐵律遵守率算法（純函式）

**Files:**
- Create: `src/routes/usage/team-overview.js`
- Test: `tests/team-overview-api.test.js`

- [ ] **Step 1: 建檔骨架（純函式先）**

新建 `src/routes/usage/team-overview.js`，先只匯出純函式（router 留到 Task 3）：

```js
import { Router } from 'express';
import { query as defaultQuery } from '../../utils/db.js';
import defaultAdminAuth from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';

/**
 * 從 session_logs.details 計算單一 session 的鐵律遵守。
 * 回傳 { complied, skipped, triggered }。triggered = complied + skipped。
 * details 為 null / 沒對應欄位時，三個值皆為 0。
 */
export function extractRuleCounts(details) {
  if (!details || typeof details !== 'object') return { complied: 0, skipped: 0, triggered: 0 };
  const complied = Array.isArray(details.rules_complied) ? details.rules_complied.length : 0;
  const skipped = Array.isArray(details.rules_skipped) ? details.rules_skipped.length : 0;
  return { complied, skipped, triggered: complied + skipped };
}

/**
 * 把多場 session 的 rule counts 加總，回傳 { complied, triggered, rate }。
 * triggered === 0 時 rate 為 null（前端顯示「—」、不參與排名）。
 */
export function aggregateCompliance(sessions) {
  let complied = 0, triggered = 0;
  for (const s of sessions) {
    const c = extractRuleCounts(s.details);
    complied += c.complied;
    triggered += c.triggered;
  }
  return {
    complied,
    triggered,
    rate: triggered === 0 ? null : complied / triggered
  };
}

/**
 * 從多場 session 票選最常做的專案（details.project）。
 * count 相同走字典序。所有 session 都沒 project → null。
 */
export function pickTopProject(sessions) {
  const counts = new Map();
  for (const s of sessions) {
    const p = s?.details?.project;
    if (typeof p !== 'string' || !p) continue;
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  })[0][0];
}

export function createTeamOverviewRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const adminAuth = deps.adminAuth ?? defaultAdminAuth;
  const router = Router();
  // routes 待 Task 4 補
  return router;
}

export default createTeamOverviewRouter();
```

- [ ] **Step 2: 寫純函式測試（fail first）**

新建 `tests/team-overview-api.test.js`：

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../src/routes/usage/team-overview.js');
const { extractRuleCounts, aggregateCompliance, pickTopProject } = mod;

describe('extractRuleCounts', () => {
  it('returns zeros for null details', () => {
    assert.deepEqual(extractRuleCounts(null), { complied: 0, skipped: 0, triggered: 0 });
  });
  it('returns zeros for details without rule arrays', () => {
    assert.deepEqual(extractRuleCounts({ project: 'foo' }), { complied: 0, skipped: 0, triggered: 0 });
  });
  it('counts rules_complied and rules_skipped', () => {
    const d = { rules_complied: ['IR-003','IR-008'], rules_skipped: ['IR-009'] };
    assert.deepEqual(extractRuleCounts(d), { complied: 2, skipped: 1, triggered: 3 });
  });
});

describe('aggregateCompliance', () => {
  it('returns rate=null when no session triggers any rule', () => {
    const sessions = [{ details: { project: 'a' } }, { details: null }];
    const r = aggregateCompliance(sessions);
    assert.equal(r.triggered, 0);
    assert.equal(r.rate, null);
  });
  it('aggregates across sessions', () => {
    const sessions = [
      { details: { rules_complied: ['IR-003','IR-008'], rules_skipped: [] } },
      { details: { rules_complied: ['IR-009'], rules_skipped: ['IR-008'] } }
    ];
    const r = aggregateCompliance(sessions);
    assert.equal(r.complied, 3);
    assert.equal(r.triggered, 4);
    assert.equal(r.rate, 0.75);
  });
});

describe('pickTopProject', () => {
  it('returns null when no project in any session', () => {
    assert.equal(pickTopProject([{ details: {} }, { details: null }]), null);
  });
  it('picks highest count', () => {
    const ss = [
      { details: { project: 'ownmind' } },
      { details: { project: 'ring' } },
      { details: { project: 'ownmind' } }
    ];
    assert.equal(pickTopProject(ss), 'ownmind');
  });
  it('breaks ties by lexicographic order', () => {
    const ss = [
      { details: { project: 'ring' } },
      { details: { project: 'ownmind' } }
    ];
    assert.equal(pickTopProject(ss), 'ownmind');
  });
});
```

- [ ] **Step 3: 跑測試**

```bash
node --test tests/team-overview-api.test.js
```

Expected: 全部 PASS（純函式已實作）。

- [ ] **Step 4: Commit**

```bash
git add src/routes/usage/team-overview.js tests/team-overview-api.test.js
git commit -m "feat(team-overview): 鐵律遵守率/票選專案算法 + 單元測試"
```

---

### Task 2: Scoreboard endpoint 實作

**Files:**
- Modify: `src/routes/usage/team-overview.js`（補 GET /）
- Modify: `tests/team-overview-api.test.js`（加 endpoint 測試）

- [ ] **Step 1: 寫 endpoint 測試（fail first）**

把以下加到 `tests/team-overview-api.test.js` 末尾：

```js
import express from 'express';

function buildApp({ queryFn, user }) {
  const fakeAdmin = (req, res, next) => {
    req.user = user;
    if (!user || !['admin','super_admin'].includes(user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
  const { createTeamOverviewRouter } = mod;
  const router = createTeamOverviewRouter({ query: queryFn, adminAuth: fakeAdmin });
  const app = express();
  app.use(express.json());
  app.use('/api/usage/admin/team-overview', router);
  return app;
}

async function request(app, { method, path }) {
  return await new Promise((resolve, reject) => {
    const req = { method, url: path, path, headers: {}, body: {} };
    const res = {
      statusCode: 200, _headers: {},
      setHeader(k,v){this._headers[k]=v;}, getHeader(k){return this._headers[k];},
      status(c){this.statusCode=c;return this;},
      json(p){resolve({status:this.statusCode,body:p});},
      send(p){resolve({status:this.statusCode,body:p});},
      end(){resolve({status:this.statusCode,body:null});}
    };
    try { app.handle(req, res, e => e ? reject(e) : resolve({ status: res.statusCode })); }
    catch (e) { reject(e); }
  });
}

describe('GET /api/usage/admin/team-overview', () => {
  it('rejects non-admin with 403', async () => {
    const app = buildApp({ queryFn: async () => ({ rows: [] }), user: { id: 2, role: 'normal' } });
    const r = await request(app, { method: 'GET', path: '/' });
    assert.equal(r.status, 403);
  });

  it('returns scoreboard rows for admin', async () => {
    const sessionRows = [
      { user_id: 1, user_name: 'Vin', last_active_at: '2026-04-28T01:00:00Z',
        session_count: 3, sessions_json: [
          { details: { project: 'ownmind', rules_complied: ['IR-003'], rules_skipped: [] } },
          { details: { project: 'ownmind', rules_complied: ['IR-008'], rules_skipped: ['IR-009'] } },
          { details: { project: 'ring' } }
        ] }
    ];
    let calls = 0;
    const queryFn = async () => { calls++; return { rows: sessionRows }; };
    const app = buildApp({ queryFn, user: { id: 1, role: 'admin' } });
    const r = await request(app, { method: 'GET', path: '/' });
    assert.equal(r.status, 200);
    assert.equal(r.body.members.length, 1);
    const m = r.body.members[0];
    assert.equal(m.user_id, 1);
    assert.equal(m.session_count, 3);
    assert.equal(m.top_project, 'ownmind');
    assert.equal(m.rule_compliance.complied, 2);
    assert.equal(m.rule_compliance.triggered, 3);
    assert.ok(Math.abs(m.rule_compliance.rate - 2/3) < 1e-9);
  });

  it('rate is null when no session triggers rules', async () => {
    const queryFn = async () => ({ rows: [{
      user_id: 2, user_name: 'Bob', last_active_at: '2026-04-28T01:00:00Z',
      session_count: 1, sessions_json: [{ details: { project: 'ownmind' } }]
    }]});
    const app = buildApp({ queryFn, user: { id: 1, role: 'admin' } });
    const r = await request(app, { method: 'GET', path: '/' });
    const m = r.body.members[0];
    assert.equal(m.rule_compliance, null);
  });

  it('defaults to last 7 days when from/to not provided', async () => {
    let captured;
    const queryFn = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
    const app = buildApp({ queryFn, user: { id: 1, role: 'admin' } });
    await request(app, { method: 'GET', path: '/' });
    // params[0] = from, params[1] = to
    const from = new Date(captured.params[0]);
    const to = new Date(captured.params[1]);
    const diffDays = (to - from) / (24*60*60*1000);
    assert.ok(diffDays >= 6.99 && diffDays <= 7.01, `expected ~7 days, got ${diffDays}`);
  });
});
```

跑：

```bash
node --test tests/team-overview-api.test.js
```

Expected: 4 個新 case 全 FAIL（router 還沒實作 GET /）。

- [ ] **Step 2: 實作 endpoint**

打開 `src/routes/usage/team-overview.js`，把 `createTeamOverviewRouter` 補成：

```js
export function createTeamOverviewRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const adminAuth = deps.adminAuth ?? defaultAdminAuth;
  const router = Router();

  router.get('/', adminAuth, async (req, res) => {
    try {
      const to = req.query.to ? new Date(req.query.to) : new Date();
      const from = req.query.from
        ? new Date(req.query.from)
        : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

      // 一支 query：每個 user 一列，sessions_json 用 jsonb_agg(details) 帶出範圍內所有 session
      // 用 LEFT JOIN users，沒登入過任何 session 的人不會出現（合理）
      const sql = `
        SELECT u.id AS user_id,
               u.name AS user_name,
               MAX(sl.created_at) AS last_active_at,
               COUNT(sl.id)::int AS session_count,
               jsonb_agg(jsonb_build_object('details', sl.details)
                         ORDER BY sl.created_at DESC) AS sessions_json
          FROM users u
          JOIN session_logs sl ON sl.user_id = u.id
         WHERE sl.created_at >= $1 AND sl.created_at <= $2
         GROUP BY u.id, u.name
         ORDER BY MAX(sl.created_at) DESC`;
      const result = await query(sql, [from.toISOString(), to.toISOString()]);

      const members = result.rows.map(row => {
        const sessions = Array.isArray(row.sessions_json) ? row.sessions_json : [];
        return {
          user_id: row.user_id,
          user_name: row.user_name,
          last_active_at: row.last_active_at,
          session_count: row.session_count,
          top_project: pickTopProject(sessions),
          rule_compliance: (() => {
            const r = aggregateCompliance(sessions);
            return r.triggered === 0 ? null : r;
          })()
        };
      });

      res.json({
        range: { from: from.toISOString(), to: to.toISOString() },
        members
      });
    } catch (err) {
      logger.error('team-overview 查詢失敗', { error: err.message });
      res.status(500).json({ error: '查詢失敗' });
    }
  });

  return router;
}
```

- [ ] **Step 3: 跑測試**

```bash
node --test tests/team-overview-api.test.js
```

Expected: 全部（含純函式 + endpoint）PASS。

- [ ] **Step 4: Commit**

```bash
git add src/routes/usage/team-overview.js tests/team-overview-api.test.js
git commit -m "feat(team-overview): scoreboard GET / endpoint + 7 天預設"
```

---

## Phase 2：後端 — Sessions Timeline API

### Task 3: Sessions endpoint 實作

**Files:**
- Modify: `src/routes/usage/team-overview.js`（補 GET /:user_id/sessions）
- Create: `tests/team-overview-sessions-api.test.js`

- [ ] **Step 1: 寫 endpoint 測試（fail first）**

新建 `tests/team-overview-sessions-api.test.js`：

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const mod = await import('../src/routes/usage/team-overview.js');
const { createTeamOverviewRouter } = mod;

function buildApp({ queryFn, user }) {
  const fakeAdmin = (req, res, next) => {
    req.user = user;
    if (!user || !['admin','super_admin'].includes(user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
  const router = createTeamOverviewRouter({ query: queryFn, adminAuth: fakeAdmin });
  const app = express();
  app.use(express.json());
  app.use('/api/usage/admin/team-overview', router);
  return app;
}

async function request(app, { method, path }) {
  return await new Promise((resolve, reject) => {
    const req = { method, url: path, path, headers: {}, body: {} };
    const res = {
      statusCode: 200, _headers: {},
      setHeader(k,v){this._headers[k]=v;}, getHeader(k){return this._headers[k];},
      status(c){this.statusCode=c;return this;},
      json(p){resolve({status:this.statusCode,body:p});},
      send(p){resolve({status:this.statusCode,body:p});},
      end(){resolve({status:this.statusCode,body:null});}
    };
    try { app.handle(req, res, e => e ? reject(e) : resolve({ status: res.statusCode })); }
    catch (e) { reject(e); }
  });
}

describe('GET /api/usage/admin/team-overview/:user_id/sessions', () => {
  it('rejects non-admin', async () => {
    const app = buildApp({ queryFn: async () => ({ rows: [] }), user: { id: 2, role: 'normal' } });
    const r = await request(app, { method: 'GET', path: '/1/sessions' });
    assert.equal(r.status, 403);
  });

  it('returns session rows shape', async () => {
    const fakeRows = [{
      id: 248, created_at: '2026-04-28T01:00:00Z',
      tool: 'claude-code', model: 'claude-opus-4-7', machine: 'Vin.local',
      summary: 'OwnMind 連發版',
      details: { project: 'ownmind', duration_turns: 60,
                 rules_complied: ['IR-003'], rules_skipped: [] },
      machine_os: 'macos', machine_scanner_version: '0.4.1'
    }];
    const queryFn = async () => ({ rows: fakeRows });
    const app = buildApp({ queryFn, user: { id: 1, role: 'admin' } });
    const r = await request(app, { method: 'GET', path: '/1/sessions' });
    assert.equal(r.status, 200);
    assert.equal(r.body.user_id, 1);
    assert.equal(r.body.sessions.length, 1);
    const s = r.body.sessions[0];
    assert.equal(s.id, 248);
    assert.equal(s.tool, 'claude-code');
    assert.equal(s.machine, 'Vin.local');
    assert.deepEqual(s.machine_meta, { os: 'macos', scanner_version: '0.4.1' });
    assert.equal(s.project, 'ownmind');
    assert.equal(s.duration_turns, 60);
    assert.equal(s.rule_compliance.complied, 1);
    assert.equal(s.rule_compliance.triggered, 1);
    assert.equal(s.rule_compliance.rate, 1);
  });

  it('machine_meta is null when heartbeat fallback yields nothing', async () => {
    const queryFn = async () => ({ rows: [{
      id: 1, created_at: '2026-04-28T01:00:00Z',
      tool: 'cursor', model: 'unknown', machine: 'mystery',
      summary: '', details: null, machine_os: null, machine_scanner_version: null
    }]});
    const app = buildApp({ queryFn, user: { id: 1, role: 'admin' } });
    const r = await request(app, { method: 'GET', path: '/1/sessions' });
    assert.equal(r.body.sessions[0].machine_meta, null);
  });

  it('rejects non-numeric user_id with 400', async () => {
    const app = buildApp({ queryFn: async () => ({ rows: [] }), user: { id: 1, role: 'admin' } });
    const r = await request(app, { method: 'GET', path: '/abc/sessions' });
    assert.equal(r.status, 400);
  });

  it('caps limit at 500', async () => {
    let captured;
    const queryFn = async (_sql, params) => { captured = params; return { rows: [] }; };
    const app = buildApp({ queryFn, user: { id: 1, role: 'admin' } });
    await request(app, { method: 'GET', path: '/1/sessions?limit=9999' });
    // limit param 在最後一個位置
    assert.equal(captured[captured.length - 1], 500);
  });
});
```

跑：

```bash
node --test tests/team-overview-sessions-api.test.js
```

Expected: 5 個 case 全 FAIL（router 沒這條 route）。

- [ ] **Step 2: 實作 endpoint**

在 `src/routes/usage/team-overview.js` 的 `createTeamOverviewRouter` 內，於現有 `router.get('/', ...)` 之後加：

```js
  router.get('/:user_id/sessions', adminAuth, async (req, res) => {
    try {
      const userId = parseInt(req.params.user_id, 10);
      if (!Number.isFinite(userId)) {
        return res.status(400).json({ error: 'user_id 必須為整數' });
      }
      const to = req.query.to ? new Date(req.query.to) : new Date();
      const from = req.query.from
        ? new Date(req.query.from)
        : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

      // 用 LATERAL 從 usage_collector_heartbeat 抓最新 OS / scanner_version 作 fallback
      const sql = `
        SELECT sl.id, sl.created_at, sl.tool, sl.model, sl.machine, sl.summary, sl.details,
               hb.os AS machine_os,
               hb.scanner_version AS machine_scanner_version
          FROM session_logs sl
     LEFT JOIN LATERAL (
                 SELECT os, scanner_version
                   FROM usage_collector_heartbeat h
                  WHERE h.user_id = sl.user_id AND h.machine = sl.machine
                  ORDER BY h.last_seen DESC
                  LIMIT 1
               ) hb ON TRUE
         WHERE sl.user_id = $1
           AND sl.created_at >= $2 AND sl.created_at <= $3
         ORDER BY sl.created_at DESC
         LIMIT $4`;
      const result = await query(sql, [userId, from.toISOString(), to.toISOString(), limit]);

      const sessions = result.rows.map(row => {
        const counts = extractRuleCounts(row.details);
        const meta = (row.machine_os || row.machine_scanner_version)
          ? { os: row.machine_os, scanner_version: row.machine_scanner_version }
          : null;
        return {
          id: row.id,
          created_at: row.created_at,
          tool: row.tool,
          model: row.model,
          machine: row.machine,
          machine_meta: meta,
          project: row.details?.project ?? null,
          duration_turns: row.details?.duration_turns ?? null,
          rule_compliance: counts.triggered === 0
            ? null
            : { complied: counts.complied, triggered: counts.triggered, rate: counts.complied / counts.triggered },
          summary: row.summary || '',
          details: row.details || {}
        };
      });

      res.json({ user_id: userId, range: { from: from.toISOString(), to: to.toISOString() }, sessions });
    } catch (err) {
      logger.error('team-overview sessions 查詢失敗', { error: err.message });
      res.status(500).json({ error: '查詢失敗' });
    }
  });
```

- [ ] **Step 3: 跑測試**

```bash
node --test tests/team-overview-sessions-api.test.js tests/team-overview-api.test.js
```

Expected: 兩支測試 9 個 case 全 PASS。

注意：第三個測試 case「machine_meta is null」期待 `null`，但實作條件是 `(machine_os || scanner_version)`。fakeRows 兩個都是 null → meta 為 null。OK。

- [ ] **Step 4: Commit**

```bash
git add src/routes/usage/team-overview.js tests/team-overview-sessions-api.test.js
git commit -m "feat(team-overview): /:user_id/sessions endpoint + machine_meta fallback"
```

---

### Task 4: 掛 router 到 `/api/usage/admin/team-overview`

**Files:**
- Modify: `src/routes/usage/index.js`

- [ ] **Step 1: 加 import + mount**

`src/routes/usage/index.js` 改成：

```js
import { Router } from 'express';
import pricingRoutes from './pricing.js';
import eventsRoutes from './events.js';
import statsRoutes from './stats.js';
import teamStatsRoutes from './team-stats.js';
import exemptionsRoutes from './exemptions.js';
import adminAuditRoutes from './admin-audit.js';
import adminClientsRoutes from './admin-clients.js';
import teamOverviewRoutes from './team-overview.js';

const router = Router();

router.use('/pricing', pricingRoutes);
router.use('/events', eventsRoutes);
router.use('/stats', statsRoutes);
router.use('/team-stats', teamStatsRoutes);
router.use('/exemptions', exemptionsRoutes);
router.use('/admin/audit', adminAuditRoutes);
router.use('/admin/clients', adminClientsRoutes);
router.use('/admin/team-overview', teamOverviewRoutes);

export default router;
```

- [ ] **Step 2: 跑全測試確認沒打到別人**

```bash
node --test
```

Expected: 全部測試 PASS。

- [ ] **Step 3: Commit**

```bash
git add src/routes/usage/index.js
git commit -m "feat(team-overview): mount router 到 /api/usage/admin/team-overview"
```

---

## Phase 3：前端 — 表格擴欄 + 預設 7 天

### Task 5: 改造 team usage 表頭與資料載入

**Files:**
- Modify: `src/public/index.html`

- [ ] **Step 1: 改表頭（行 433-444 附近）**

找到 `<thead><tr>` 起的團隊用量表頭，改成：

```html
<thead><tr>
  <th>成員</th>
  <th title="該成員最近一次寫入 session_log 的時間">最近活動</th>
  <th style="text-align:right;" title="來自 session_logs：AI 主動寫入的會話紀錄數">對話場次</th>
  <th title="該成員 7 天內 session_logs.details.project 出現次數最高者；票數相同走字典序">最常做的專案</th>
  <th style="text-align:right;" title="rules_complied / (rules_complied + rules_skipped)，全段 sum 後再除">鐵律遵守率</th>
  <th style="text-align:right;" title="按 API rate card 換算；訂閱用戶實際支出以方案為準">Notional 成本 (USD)</th>
  <th style="text-align:right;" title="真正新輸入的 tokens（不含 cache）">Input</th>
  <th style="text-align:right;" title="output + reasoning">Output</th>
  <th style="text-align:right;" title="cache_creation — 寫入 cache 的 tokens">Cache In</th>
  <th style="text-align:right;" title="cache_read — 從 cache 讀出的 tokens">Cache Out</th>
  <th style="text-align:right;">訊息</th>
  <th style="text-align:right;">活躍時長</th>
  <th style="text-align:right;" title="來自 usage_metrics_daily：collector 端觀察的對話 session（不一定等於對話場次）">Session</th>
</tr></thead>
```

- [ ] **Step 2: 找 `loadTeamUsage()` 函式，加先讀 team-overview 並 merge**

在 `src/public/index.html` 搜 `function loadTeamUsage` 或 `async function loadTeamUsage`。在現有 fetch usage 的地方平行打新 API：

```js
async function loadTeamUsage() {
  const from = document.getElementById('teamUsageFrom').value;
  const to = document.getElementById('teamUsageTo').value;
  const sortBy = document.getElementById('teamSortBy').value;
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  qs.set('sort_by', sortBy);

  try {
    // 平行打：用量 + 成績單
    const [usageRes, overviewRes] = await Promise.all([
      fetch(`/api/usage/team-stats?${qs}`, { credentials: 'include' }),
      fetch(`/api/usage/admin/team-overview?${(() => {
        const q = new URLSearchParams();
        if (from) q.set('from', from);
        if (to) q.set('to', to);
        return q;
      })()}`, { credentials: 'include' })
    ]);
    if (!usageRes.ok) throw new Error('usage fetch failed');
    const usage = await usageRes.json();
    const overview = overviewRes.ok ? await overviewRes.json() : { members: [] };

    // 用 user_id 把 overview merge 進 usage 每一列
    const overviewMap = new Map(overview.members.map(m => [m.user_id, m]));
    const merged = (usage.members || []).map(u => ({
      ...u,
      _overview: overviewMap.get(u.user_id) || null
    }));
    renderTeamUsersTable(merged);
  } catch (err) {
    showToast('載入團隊用量失敗：' + err.message, true);
  }
}
```

（注意：實際 `/api/usage/team-stats` 的回傳結構要對齊現有實作；若 key 不是 `members` 而是其他名字，沿用現有名稱。先用 grep 找到 `renderTeamUsersTable` 看現有 key。）

- [ ] **Step 3: 改 `renderTeamUsersTable()` 多吐三欄**

找到 `function renderTeamUsersTable(rows)` 或類似的。在現有 `<td>` 串起來的 template literal 裡，於成員名後面、成本欄前面插入：

```js
const ov = row._overview;
const lastActive = ov?.last_active_at ? formatRelativeTime(ov.last_active_at) : '—';
const sessionCount = ov?.session_count ?? '—';
const topProject = ov?.top_project ?? '—';
const compl = ov?.rule_compliance;
const rateStr = compl ? `${Math.round(compl.rate * 100)}%` : '—';
const rateColor = !compl ? '#86868b'
                : compl.rate >= 0.9 ? '#16a34a'
                : compl.rate < 0.7 ? '#dc2626'
                : '#3a3a3c';
// 在 td 串中對應位置插入：
//   <td>${escapeHtml(row.name)}</td>
//   <td title="${ov?.last_active_at ?? ''}">${lastActive}</td>
//   <td style="text-align:right;">${sessionCount}</td>
//   <td>${escapeHtml(topProject)}</td>
//   <td style="text-align:right;color:${rateColor};">${rateStr}</td>
//   ...原有 cost/input/output/... 欄位
```

如果檔案沒有 `formatRelativeTime` 或 `escapeHtml` helper，加在 `<script>` 區塊頂端：

```js
function formatRelativeTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小時前`;
  const d = Math.round(h / 24);
  return `${d} 天前`;
}
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
```

（若已存在則跳過。）

- [ ] **Step 4: 預設帶 7 天**

找到 `tab-team-usage` 切換 / dashboard 載入時呼叫 `loadTeamUsage()` 的地方，於前面填預設值。在 `<script>` 區塊找 `switchTab('team-usage')` 或 `loadTeamUsage()` 第一次被呼叫處，於進 tab 時：

```js
// switchTab('team-usage') 或 dashboard ready 時 + 進 tab 時
function ensureTeamUsageDefaultDates() {
  const fromEl = document.getElementById('teamUsageFrom');
  const toEl = document.getElementById('teamUsageTo');
  if (!fromEl.value && !toEl.value) {
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7*24*60*60*1000);
    fromEl.value = sevenDaysAgo.toISOString().slice(0,10);
    toEl.value = today.toISOString().slice(0,10);
  }
}
```

並在進 tab 時呼叫一次：在 `switchTab` 函式或 admin tab 顯示後：

```js
if (tabName === 'team-usage') {
  ensureTeamUsageDefaultDates();
  loadTeamUsage();
}
```

（具體掛點看 `switchTab` 的現有邏輯，配合插入。）

- [ ] **Step 5: 瀏覽器人工驗證（IR-020）**

```bash
npm start &  # 或 docker compose up -d，依 OwnMind 實際啟動方式
```

打開 `http://localhost:3100/admin/`，登入 admin 帳號，切到「團隊用量」分頁。檢查：

- [ ] 日期欄位自動帶當天往前 7 天
- [ ] 表頭依序是「成員 / 最近活動 / 對話場次 / 最常做的專案 / 鐵律遵守率 / Notional 成本 / Input / Output / Cache In / Cache Out / 訊息 / 活躍時長 / Session」
- [ ] hover 鐵律遵守率欄位 tooltip 解釋公式
- [ ] hover Session 欄位 tooltip 解釋與「對話場次」差異

- [ ] **Step 6: Commit**

```bash
git add src/public/index.html
git commit -m "feat(dashboard): 團隊用量表加成績單欄位 + 7 天預設"
```

---

## Phase 4：前端 — 「最近對話」區塊

### Task 6: 成員詳情卡新增「最近對話」摺疊區

**Files:**
- Modify: `src/public/index.html`

- [ ] **Step 1: 加 HTML 區塊**

在 `src/public/index.html` 的 `<div id="memberDetailBars">` 之後（行 471 附近），補上：

```html
<div style="margin-top:24px;border-top:1px solid #e5e5e7;padding-top:16px;">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
    <h4 style="font-size:13px;color:#86868b;margin:0;">最近對話 <span id="memberDetailSessionLogsCount"></span></h4>
    <button class="btn-sm btn-ghost" id="memberDetailSessionLogsToggle" onclick="toggleMemberSessionLogs()">展開</button>
  </div>
  <div id="memberDetailSessionLogs" class="hidden">
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>時間</th><th>工具</th><th>模型</th><th>機器</th>
          <th>專案</th><th style="text-align:right;">輪數</th>
          <th style="text-align:right;">遵守%</th><th>摘要</th>
        </tr></thead>
        <tbody id="memberDetailSessionLogsBody"></tbody>
      </table>
    </div>
  </div>
</div>
```

- [ ] **Step 2: 加 JS：toggle + 載入流水**

在 `<script>` 區塊找到 `loadMemberDetail` 或 `openMemberDetail`，於同一區補：

```js
let _memberSessionLogsLoaded = null;  // 暫存 user_id

async function toggleMemberSessionLogs() {
  const wrap = document.getElementById('memberDetailSessionLogs');
  const btn = document.getElementById('memberDetailSessionLogsToggle');
  if (wrap.classList.contains('hidden')) {
    const userId = currentMemberDetailUserId;  // 由 openMemberDetail 設定
    if (!userId) return;
    if (_memberSessionLogsLoaded !== userId) {
      await loadMemberSessionLogs(userId);
      _memberSessionLogsLoaded = userId;
    }
    wrap.classList.remove('hidden');
    btn.textContent = '收合';
  } else {
    wrap.classList.add('hidden');
    btn.textContent = '展開';
  }
}

async function loadMemberSessionLogs(userId) {
  const from = document.getElementById('detailFrom').value;
  const to = document.getElementById('detailTo').value;
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  qs.set('limit', 100);
  try {
    const res = await fetch(`/api/usage/admin/team-overview/${userId}/sessions?${qs}`,
                           { credentials: 'include' });
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    document.getElementById('memberDetailSessionLogsCount').textContent =
      `(${data.sessions.length})`;
    const body = document.getElementById('memberDetailSessionLogsBody');
    body.innerHTML = data.sessions.map(s => renderSessionLogRow(s)).join('');
  } catch (err) {
    showToast('載入對話流水失敗：' + err.message, true);
  }
}

function renderSessionLogRow(s) {
  const machine = s.machine_meta
    ? `${escapeHtml(s.machine)}<br><small style="color:#86868b;font-size:12px;">${escapeHtml(s.machine_meta.os || '')} · ${escapeHtml(s.machine_meta.scanner_version || '')}</small>`
    : escapeHtml(s.machine || '—');
  const rateStr = s.rule_compliance
    ? `${Math.round(s.rule_compliance.rate * 100)}%`
    : '—';
  const summary = (s.summary || '').length > 60
    ? escapeHtml(s.summary.slice(0, 60)) + '…'
    : escapeHtml(s.summary || '');
  return `
    <tr>
      <td>${formatRelativeTime(s.created_at)}</td>
      <td>${escapeHtml(s.tool || '—')}</td>
      <td>${escapeHtml(s.model || '—')}</td>
      <td>${machine}</td>
      <td>${escapeHtml(s.project || '—')}</td>
      <td style="text-align:right;">${s.duration_turns ?? '—'}</td>
      <td style="text-align:right;">${rateStr}</td>
      <td title="${escapeHtml(s.summary || '')}">${summary}</td>
    </tr>`;
}
```

- [ ] **Step 3: 把 `currentMemberDetailUserId` 設好**

在 `openMemberDetail(userId)` 函式（或同等開卡片函式）加：

```js
let currentMemberDetailUserId = null;

function openMemberDetail(userId) {
  currentMemberDetailUserId = userId;
  _memberSessionLogsLoaded = null;
  document.getElementById('memberDetailSessionLogs').classList.add('hidden');
  document.getElementById('memberDetailSessionLogsToggle').textContent = '展開';
  document.getElementById('memberDetailSessionLogsCount').textContent = '';
  // ...原本的開卡片邏輯
}
```

- [ ] **Step 4: 瀏覽器人工驗證**

打開 dashboard → 團隊用量 → 點某個成員名字（展開「成員詳情」）→ 拉到底有「最近對話」摺疊區 → 點「展開」 → 表格出現 → 機器名底下灰字顯示 OS · scanner_version（heartbeat 有資料的成員）。

- [ ] **Step 5: Commit**

```bash
git add src/public/index.html
git commit -m "feat(dashboard): 成員詳情卡新增「最近對話」流水區（machine 副資訊）"
```

---

## Phase 5：前端 — Audit Log 改名

### Task 7: 改名「資料品質警示」+ 加說明列

**Files:**
- Modify: `src/public/index.html`

- [ ] **Step 1: 改標題 + 加說明（行 475-499 附近）**

找到 `<!-- Audit log -->` 註解後的 card，改成：

```html
<!-- 資料品質警示（原 Audit log） -->
<div class="card">
  <div class="card-header">
    <h3>資料品質警示</h3>
    <select id="auditEventType" style="width:auto;margin:0;" onchange="loadAuditLog()">
      <option value="">-- 全部 --</option>
      <option value="unknown_model">unknown_model</option>
      <option value="token_regression">token_regression</option>
      <option value="fingerprint_collision">fingerprint_collision</option>
      <option value="fingerprint_mismatch">fingerprint_mismatch</option>
      <option value="codex_missing_material">codex_missing_material</option>
      <option value="ingestion_suppressed_exempt">ingestion_suppressed_exempt</option>
      <option value="exemption_granted">exemption_granted</option>
      <option value="exemption_reason_updated">exemption_reason_updated</option>
      <option value="exemption_revoked">exemption_revoked</option>
    </select>
  </div>
  <div style="margin:8px 0 12px;padding:8px 12px;background:#fef3c7;color:#92400e;border-radius:6px;font-size:12px;line-height:1.6;">
    這裡記錄資料抓取時的異常事件（model 無法識別、token 數倒退、指紋衝突等），給管理員追問題用。<b>不是團隊活動紀錄</b>，活動紀錄請看上方「團隊用量排行榜」與成員詳情。
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>時間</th><th>User</th><th>Tool</th><th>Event Type</th><th>Details</th>
      </tr></thead>
      <tbody id="auditLogTable"></tbody>
    </table>
  </div>
</div>
```

不動 JS 函式名（`loadAuditLog` / `auditLogTable` 維持）。

- [ ] **Step 2: 瀏覽器人工驗證**

`http://localhost:3100/admin/` → 團隊用量 → 拉到底 → 看到「資料品質警示」標題 + 黃色說明列 + 下方表格仍能正常拉資料。

- [ ] **Step 3: Commit**

```bash
git add src/public/index.html
git commit -m "feat(dashboard): Audit Log 改名「資料品質警示」+ 加說明列"
```

---

## Phase 6：發版前作業

### Task 8: 版號 + 文件 + Changelog

**Files:**
- Modify: `package.json`、`CHANGELOG.md`、`README.md`、`README.en.md`、`README.ja.md`、`FILELIST.md`

- [ ] **Step 1: 改 package.json 版號**

```bash
sed -i.bak 's/"version": "1.17.16"/"version": "1.17.17"/' package.json && rm package.json.bak
grep '"version"' package.json
```

Expected: `"version": "1.17.17",`

- [ ] **Step 2: 加 CHANGELOG entry**

在 `CHANGELOG.md` 最頂端（`## v1.17.16` 之上）插：

```markdown
## v1.17.17 — Dashboard 團隊一覽改造

**背景**：admin 在 dashboard 上看不到「最近 7 天每位成員整體在做什麼、守鐵律守得如何」。「Audit Log」這個名字也誤導，user 直覺以為是團隊活動紀錄，實際內容是 ingestion 異常事件。

**改動**

- 後端新增 `GET /api/usage/admin/team-overview` — 每位成員的最近活動、對話場次、最常做的專案、鐵律遵守率（從 `session_logs.details` 彙總）
- 後端新增 `GET /api/usage/admin/team-overview/:user_id/sessions` — 該成員最近 N 場 session 流水（含 `machine_meta` 副資訊：OS / scanner_version）
- 前端「團隊用量排行榜」加四欄：最近活動 / 對話場次 / 最常做的專案 / 鐵律遵守率
- 前端日期篩選器預設帶最近 7 天
- 前端「成員詳情」卡新增「最近對話」摺疊區
- 「Audit Log」改名「資料品質警示」+ 加說明列說明它不是團隊活動紀錄
- 機器名旁加 OS · scanner_version 副資訊（避免 Bob 機器叫「after」這類短名造成 UX 混淆）

**新增測試**

- `tests/team-overview-api.test.js` — 鐵律遵守率算法、票選專案、scoreboard endpoint（含 7 天預設）
- `tests/team-overview-sessions-api.test.js` — sessions endpoint、machine_meta fallback、limit 上限 500

**No schema migration**：完全沿用現有 `session_logs` / `users` / `usage_collector_heartbeat` 資料表。

**相容性**：v1.16 之前的 session 沒填 `details.project` / `details.rules_*` 的會被忽略不算（前端顯示「—」），不擋查詢。

**鐵律對應**：IR-022（Server + Client 兩端同改）、IR-031（package.json 同步推 1.17.17）、IR-008 / IR-026（CHANGELOG / README / FILELIST 同步）、IR-020（部署後瀏覽器實測）。
```

- [ ] **Step 3: README 三語系版號（IR-032）**

在三份 README（`README.md` / `README.en.md` / `README.ja.md`）grep 「v1.17.16」或 badge 區塊：

```bash
grep -n "1.17.16\|1\.17\.16" README.md README.en.md README.ja.md
```

把所有命中改成 `1.17.17`：

```bash
sed -i.bak 's/1\.17\.16/1.17.17/g' README.md README.en.md README.ja.md && rm README*.bak
```

- [ ] **Step 4: FILELIST 加新檔**

打開 `FILELIST.md`，在合適區塊（route / test）追加：

```
src/routes/usage/team-overview.js — 團隊一覽 admin API（scoreboard + sessions timeline）
tests/team-overview-api.test.js — 團隊一覽 scoreboard 單元測試
tests/team-overview-sessions-api.test.js — 團隊一覽 sessions 單元測試
docs/superpowers/specs/2026-04-28-dashboard-team-overview-design.md — v1.17.17 spec
docs/superpowers/plans/2026-04-28-dashboard-team-overview.md — v1.17.17 plan
```

- [ ] **Step 5: 跑全測試 + lint（如有）**

```bash
node --test
```

Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add package.json CHANGELOG.md README.md README.en.md README.ja.md FILELIST.md
git commit -m "chore(release): v1.17.17 — 版號 + CHANGELOG + README 三語系"
```

---

### Task 9: 部署 + 瀏覽器實測

- [ ] **Step 1: 確認 git 狀態乾淨**

```bash
git status
git log --oneline origin/main..HEAD
```

Expected: 工作區乾淨；7 個 commit 在 `origin/main` 之後（每個 phase 一個）。

- [ ] **Step 2: 推 PR + tag（依專案發版流程）**

```bash
git push origin HEAD
git tag v1.17.17
git push origin v1.17.17
```

如果走 PR + review 流程，先開 PR、merge 後再 tag。tag 推上去觸發 CI/CD 部署到 example.com。

- [ ] **Step 3: 等 server 部署完成，IR-019 + IR-020 雙重驗證**

IR-019：版本檢查不能只看本地 origin。

```bash
curl -s https://example.com/api/health | grep version
# 或
curl -s https://example.com/api/memory/init -H "x-api-key: ..." | jq .server_version
```

Expected: `1.17.17`。

IR-020：瀏覽器實測 §8.2 五項（spec 內列）：

- [ ] macOS Chrome 開 dashboard，預設帶 7 天看排行榜：欄位齊全、最近活動相對時間正確
- [ ] 鐵律遵守率紅綠灰三種色看得到（造資料測或挑現有資料）
- [ ] 點某成員 → 對話流水分頁出現 → 機器副資訊顯示 / 不顯示兩種狀態
- [ ] 「資料品質警示」標題改了、說明列出現
- [ ] 一般 admin（非 super_admin）打開能看；普通成員看不到 tab

- [ ] **Step 4: 驗證 OwnMind broadcast 自動清掉舊版警示**

session_log #248 friction_points 提到「broadcast 通知在已升級到最新版後仍持續顯示」。部署後，新登入的 client 應該不再看到 v1.17.14/15/16 的廣播。如果還看到，是 broadcast TTL 沒清，記錄到 backlog 不阻擋本次。

---

## Self-Review

### Spec coverage

| Spec section | Plan task |
|---|---|
| §1.1 命名誤解（Audit Log） | Task 7 |
| §1.2 缺漏功能（成績單 / 流水帳） | Task 1-3, 5-6 |
| §1.3 machine UX（Bob case） | Task 3, 6（machine_meta） |
| §3.2 鐵律遵守率算法 | Task 1（pure func） |
| §3.5 票選專案 | Task 1（pure func） |
| §4.1 scoreboard API | Task 2 |
| §4.2 sessions API | Task 3 |
| §5.1 表格擴欄 | Task 5 |
| §5.2「最近對話」 | Task 6 |
| §5.3 改名 | Task 7 |
| §6 權限 | Task 2/3 測試 + 沿用 adminAuth |
| §7 容錯 | Task 1（純函式 + null safe）+ Task 2/3 測試 |
| §8 測試計畫 | Task 1-3 含覆蓋；§8.2 手動 checklist 在 Task 5/6/7/9 |
| §10 IR-031 / IR-008 / IR-022 / IR-020 | Task 8 + 9 |

### Placeholder scan

- 所有 step 都有實際 code / 命令 ✓
- 沒有「TBD / TODO / 自行斟酌」 ✓
- formatRelativeTime / escapeHtml helper 提供完整實作 ✓

### Type / 命名一致性

- `extractRuleCounts` / `aggregateCompliance` / `pickTopProject` 三個 export 名稱跨 task 一致 ✓
- API 回傳 `rule_compliance` 在 scoreboard 與 sessions 兩處名稱一致 ✓
- `machine_meta` shape 在 spec § 4.2 與 plan Task 3 / Task 6 一致（{ os, scanner_version }）✓

---

## Execution Handoff

Plan 完成，存到 `docs/superpowers/plans/2026-04-28-dashboard-team-overview.md`。實作策略二選一：

**1. Subagent-Driven（推薦）**：每個 task 派一個新的 subagent 跑、回來 review 後再派下一個。獨立 context、不會被舊累積干擾。

**2. Inline Execution**：直接在這個 session 內按 task 跑，每跑完 1-2 個 phase 停下來 review。

哪種？
