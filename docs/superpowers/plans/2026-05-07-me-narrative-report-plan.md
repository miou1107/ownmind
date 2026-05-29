# /me 敘事報告 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/ownmind/me` 加「📊 敘事報告」分頁，產出 HackMD 風格 12 段團隊分析；機械段秒回，LLM 段開頁自動觸發、server-side cache 1 小時。

**Architecture:** 兩個 endpoint — `GET /api/me/narrative` 純 SQL 重組 + 補 2 個新查詢；`GET /api/me/narrative/insights` 呼叫 llm-switch（OpenAI-compatible）+ in-memory hash cache。Frontend 新 tab 平行 fetch 兩 endpoint，機械段先 render、LLM placeholder 等回填。

**Tech Stack:** Node.js + Express + node:test + PostgreSQL + Mermaid (CDN) + llm-switch (https://example.com/llm-switch/v1，OpenAI-compatible，model='auto')

**Spec:** [docs/superpowers/specs/2026-05-07-me-narrative-report-design.md](../specs/2026-05-07-me-narrative-report-design.md)

---

## File Structure

| 檔案 | 動作 | 責任 |
|------|------|------|
| `src/lib/llm-narrative.js` | 新增 | llm-switch HTTP wrapper：buildPrompt + callLLM + parseJSON。獨立可測 |
| `src/lib/narrative-cache.js` | 新增 | in-memory `Map<hashKey, {value, expiresAt}>`，get/set/sweep API |
| `src/routes/me-narrative.js` | 新增 | 兩個 endpoint：機械 + LLM。注入 `query` 跟 `llmCall` 方便測試 |
| `src/app.js` | 修改 | 掛 `/api/me/narrative` 路由 |
| `src/public/me/index.html` | 修改 | 新 tab + 12 section render + auto LLM fetch + placeholder |
| `.env.example` | 修改 | 補 `LLM_SWITCH_API_KEY=` 註記 |
| `tests/me-narrative.test.js` | 新增 | mechanical schema、insights cache hit、no key → 503 |
| `tests/llm-narrative.test.js` | 新增 | buildPrompt schema、parseJSON tolerance |
| `tests/narrative-cache.test.js` | 新增 | get/set/expire |
| `package.json` / README*.md / CHANGELOG.md / FILELIST.md | 修改 | 1.17.46 → 1.17.47 + 條目（IR-031 / IR-008 / IR-032） |

---

## Task 1：narrative-cache 模組（最小單位先做）

**Files:**
- Create: `src/lib/narrative-cache.js`
- Test: `tests/narrative-cache.test.js`

- [ ] **Step 1：寫失敗測試**

```js
// tests/narrative-cache.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNarrativeCache } from '../src/lib/narrative-cache.js';

describe('narrativeCache', () => {
  it('set 後立刻 get 拿得到', () => {
    const c = createNarrativeCache({ ttlMs: 1000 });
    c.set('k1', { foo: 1 });
    assert.deepEqual(c.get('k1'), { foo: 1 });
  });

  it('過期後 get 回 null', () => {
    const c = createNarrativeCache({ ttlMs: 1, now: () => 0 });
    c.set('k2', 'v');
    c._setNow(() => 100);
    assert.equal(c.get('k2'), null);
  });

  it('不同 key 互不影響', () => {
    const c = createNarrativeCache({ ttlMs: 1000 });
    c.set('a', 1); c.set('b', 2);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('b'), 2);
  });
});
```

- [ ] **Step 2：跑測試確認 fail**

Run: `node --test tests/narrative-cache.test.js`
Expected: FAIL — Cannot find module `'../src/lib/narrative-cache.js'`

- [ ] **Step 3：最小實作**

```js
// src/lib/narrative-cache.js
export function createNarrativeCache({ ttlMs = 3_600_000, now = () => Date.now() } = {}) {
  const store = new Map();
  let _now = now;
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (_now() > entry.expiresAt) { store.delete(key); return null; }
      return entry.value;
    },
    set(key, value) {
      store.set(key, { value, expiresAt: _now() + ttlMs });
    },
    _setNow(fn) { _now = fn; },
  };
}
```

- [ ] **Step 4：跑測試確認 pass**

Run: `node --test tests/narrative-cache.test.js`
Expected: 3 pass

- [ ] **Step 5：commit**

```bash
git add src/lib/narrative-cache.js tests/narrative-cache.test.js
git commit -m "feat(narrative): add in-memory hash cache for /me narrative insights"
```

---

## Task 2：llm-narrative 模組（buildPrompt + parseJSON）

**Files:**
- Create: `src/lib/llm-narrative.js`
- Test: `tests/llm-narrative.test.js`

- [ ] **Step 1：寫失敗測試**

```js
// tests/llm-narrative.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, parseLLMJson, computeDataHash } from '../src/lib/llm-narrative.js';

describe('buildMessages', () => {
  it('回傳 system + user 兩條 message', () => {
    const msgs = buildMessages({ ranking: [], versions: [] });
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[1].role, 'user');
    assert.match(msgs[0].content, /OwnMind/);
  });
});

describe('parseLLMJson', () => {
  it('純 JSON 直接解析', () => {
    const out = parseLLMJson('{"summary_one_line":"x"}');
    assert.equal(out.summary_one_line, 'x');
  });

  it('用 ```json 包圍也能解析', () => {
    const out = parseLLMJson('```json\n{"summary_one_line":"y"}\n```');
    assert.equal(out.summary_one_line, 'y');
  });

  it('parse 失敗丟 Error 含 raw', () => {
    assert.throws(() => parseLLMJson('not json'), /raw/);
  });
});

describe('computeDataHash', () => {
  it('同樣 input 同樣 hash', () => {
    const a = computeDataHash({ x: 1, y: 2 });
    const b = computeDataHash({ y: 2, x: 1 });
    assert.equal(a, b);
  });

  it('不同 input 不同 hash', () => {
    assert.notEqual(computeDataHash({ x: 1 }), computeDataHash({ x: 2 }));
  });
});
```

- [ ] **Step 2：跑測試確認 fail**

Run: `node --test tests/llm-narrative.test.js`
Expected: FAIL

- [ ] **Step 3：實作**

```js
// src/lib/llm-narrative.js
import { createHash } from 'node:crypto';

const SYSTEM_PROMPT = `你是 OwnMind 內部的數據敘事 agent。
輸入是一份團隊使用統計 JSON。請以「白話、不裝專業」風格產出 JSON，schema：
{
  "summary_one_line": "一句話結論",
  "section_explanations": {
    "ranking": "...", "versions": "...", "daily": "...", "hourly": "...",
    "weekday": "...", "event_types": "...", "compliance": "...",
    "update_health": "...", "project_ranking": "...", "project_compliance": "..."
  },
  "project_friction": { "<project_key>": ["踩坑短句", ...] },
  "insights_for_admin": ["洞察 1", "洞察 2", "洞察 3"],
  "next_actions": ["動作 1", "動作 2", "動作 3"]
}
規則：
- 只回 JSON、不加 markdown 圍欄、不加說明文字
- 「白話講」每段 1-3 句，避免術語
- project_friction 從 friction_raw 萃取，沒資料就回空陣列
- 對事不對人，不評論個人能力`;

export function buildMessages(narrativeData) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(narrativeData) },
  ];
}

export function parseLLMJson(raw) {
  let cleaned = String(raw).trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) cleaned = fenced[1].trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`LLM JSON parse failed: ${err.message}; raw=${raw.slice(0, 200)}`);
  }
}

export function computeDataHash(data) {
  const stable = stableStringify(data);
  return createHash('sha256').update(stable).digest('hex');
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export async function callLLMSwitch({ apiKey, messages, fetchImpl = fetch, timeoutMs = 30_000 }) {
  if (!apiKey) throw new Error('LLM_SWITCH_API_KEY not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://example.com/llm-switch/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'auto',
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 2000,
        messages,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`LLM upstream ${res.status}: ${txt.slice(0, 200)}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content || '';
    return parseLLMJson(content);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4：跑測試確認 pass**

Run: `node --test tests/llm-narrative.test.js`
Expected: 6 pass

- [ ] **Step 5：commit**

```bash
git add src/lib/llm-narrative.js tests/llm-narrative.test.js
git commit -m "feat(narrative): add llm-switch wrapper (buildMessages + parseLLMJson + dataHash)"
```

---

## Task 3：narrative router — 機械 endpoint

**Files:**
- Create: `src/routes/me-narrative.js`
- Test: `tests/me-narrative.test.js`

機械段資料 = 重整 `/api/me/report` 既有欄位 + 補 2 個新查詢（project_compliance、project_friction_raw）。

- [ ] **Step 1：寫機械 endpoint 測試**

```js
// tests/me-narrative.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createNarrativeRouter } from '../src/routes/me-narrative.js';

function fakeAuth(req, res, next) { req.user = { id: 1, name: 'Vin', role: 'super_admin' }; next(); }

function fakeQuery(map) {
  return async (sql, params) => {
    for (const key of Object.keys(map)) {
      if (sql.includes(key)) return { rows: map[key] };
    }
    return { rows: [] };
  };
}

async function buildApp(opts) {
  const router = createNarrativeRouter({ auth: fakeAuth, ...opts });
  const app = express();
  app.use(express.json());
  app.use('/api/me/narrative', router);
  return app;
}

describe('GET /api/me/narrative', () => {
  it('回傳 12 個 section keys', async () => {
    const app = await buildApp({
      query: fakeQuery({
        'session_logs': [{ project_key: 'p1', body: { friction: 'x' } }],
        'iron_rule_compliance': [],
        'activity_events': [],
      }),
    });
    const res = await request(app).get('/api/me/narrative?range=14d');
    assert.equal(res.status, 200);
    const expected = ['ranking', 'versions', 'daily', 'hourly', 'weekday',
                      'event_types', 'compliance', 'update_health',
                      'project_ranking', 'project_friction_raw', 'project_compliance'];
    for (const k of expected) assert.ok(res.body.sections[k] !== undefined, `missing ${k}`);
  });
});

// minimal fetch helper
async function request(app) {
  const { default: http } = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      return { get: (path) => http.get(`http://127.0.0.1:${port}${path}`, (r) => { /* ... */ }) };
    });
  });
}
```

> NOTE：node 內建沒 supertest，可改用 `node:http` request 或裝 `supertest`。本專案既有測試怎麼做就照做 — 先看 `tests/admin-work-log.test.js` 是否有現成 helper。若無，加 `supertest` 為 dev dep（`npm i -D supertest`）並改用之。

- [ ] **Step 2：用 supertest（如果現有測試已用）或寫 fetch helper，把測試跑起來確認 fail**

Run: `node --test tests/me-narrative.test.js`
Expected: FAIL — module not found

- [ ] **Step 3：實作機械 endpoint**

```js
// src/routes/me-narrative.js
import { Router } from 'express';

export function createNarrativeRouter({ query, auth, llmCall, cache, env = process.env }) {
  const router = Router();
  router.use(auth);

  router.get('/', async (req, res) => {
    try {
      const range = req.query.range || '14d';
      const days = parseRange(range);
      const sections = await collectSections({ query, days });
      res.json({
        range,
        generated_at: new Date().toISOString(),
        sections,
      });
    } catch (err) {
      console.error('narrative mechanical failed', err);
      res.status(500).json({ error: '敘事報告產生失敗' });
    }
  });

  // (insights endpoint added in Task 4)

  return router;
}

function parseRange(r) {
  const m = String(r).match(/^(\d+)d$/);
  return m ? parseInt(m[1], 10) : 14;
}

async function collectSections({ query, days }) {
  const since = `now() - interval '${days} days'`;

  const ranking = (await query(`
    SELECT u.name, u.role,
           COUNT(DISTINCT s.session_id) AS sessions,
           COUNT(e.id) AS events,
           MAX(e.created_at) AS last_activity
    FROM web_users u
    LEFT JOIN session_logs s ON s.user_id = u.id AND s.created_at >= ${since}
    LEFT JOIN activity_events e ON e.user_id = u.id AND e.created_at >= ${since}
    WHERE u.deleted_at IS NULL
    GROUP BY u.id, u.name, u.role
    ORDER BY events DESC NULLS LAST
  `)).rows;

  const versions = (await query(`
    SELECT user_id, tool, version, last_seen
    FROM client_heartbeats
    WHERE last_seen >= ${since}
    ORDER BY user_id, tool
  `)).rows;

  const daily = (await query(`
    SELECT to_char(date_trunc('day', created_at), 'MM-DD') AS d, COUNT(*) AS c
    FROM activity_events
    WHERE created_at >= ${since}
    GROUP BY 1 ORDER BY 1
  `)).rows;

  const hourly = (await query(`
    SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Taipei') AS h, COUNT(*) AS c
    FROM activity_events
    WHERE created_at >= ${since}
    GROUP BY 1 ORDER BY 1
  `)).rows;

  const weekday = (await query(`
    SELECT EXTRACT(DOW FROM created_at AT TIME ZONE 'Asia/Taipei') AS dow, COUNT(*) AS c
    FROM activity_events
    WHERE created_at >= ${since}
    GROUP BY 1 ORDER BY 1
  `)).rows;

  const event_types = (await query(`
    SELECT event, COUNT(*) AS c
    FROM activity_events
    WHERE created_at >= ${since}
    GROUP BY 1 ORDER BY c DESC
  `)).rows;

  const compliance = (await query(`
    SELECT details->>'rule_code' AS rule_code,
           COUNT(*) FILTER (WHERE details->>'action'='comply') AS comply,
           COUNT(*) FILTER (WHERE details->>'action'='skip') AS skip,
           COUNT(*) FILTER (WHERE details->>'action'='violate') AS violate,
           COUNT(*) FILTER (WHERE details->>'action'='observed_trigger') AS observed
    FROM activity_events
    WHERE event='iron_rule_compliance' AND created_at >= ${since}
    GROUP BY 1 ORDER BY 1
  `)).rows;

  const update_health = (await query(`
    SELECT event, COUNT(*) AS c
    FROM activity_events
    WHERE event IN ('update_check','update_success','update_failure','no_new_version','init_failed')
      AND created_at >= ${since}
    GROUP BY 1
  `)).rows;

  const project_ranking = (await query(`
    SELECT project_key, project, user_id, name,
           COUNT(DISTINCT session_id) AS sessions,
           COALESCE(SUM(turns),0) AS turns
    FROM session_logs s LEFT JOIN web_users u ON u.id=s.user_id
    WHERE s.created_at >= ${since}
    GROUP BY 1,2,3,4
  `)).rows;

  const project_friction_raw = (await query(`
    SELECT project_key, body->'friction' AS friction
    FROM session_logs
    WHERE created_at >= ${since} AND body->'friction' IS NOT NULL
    LIMIT 100
  `)).rows;

  const project_compliance = (await query(`
    SELECT details->>'project_key' AS project_key,
           details->>'rule_code' AS rule_code,
           COUNT(*) AS c
    FROM activity_events
    WHERE event='iron_rule_compliance'
      AND details->>'action'='comply'
      AND created_at >= ${since}
    GROUP BY 1,2 ORDER BY 1,2
  `)).rows;

  return {
    ranking, versions, daily, hourly, weekday,
    event_types, compliance, update_health,
    project_ranking, project_friction_raw, project_compliance,
  };
}
```

> NOTE：實際 SQL 欄位名請對照本 repo 的 `me.js` 既有查詢調整 — 這裡先給結構，實作時逐句驗證 column 真實存在；schema 不對就改 SQL。

- [ ] **Step 4：跑測試確認 mechanical pass**

Run: `node --test tests/me-narrative.test.js`
Expected: pass

- [ ] **Step 5：mount router 到 app.js**

```js
// src/app.js
import meNarrativeRoutes from './routes/me-narrative.js';
import { query } from './lib/db.js';
import { auth } from './middleware/auth.js'; // or whatever existing path

app.use('/api/me/narrative', meNarrativeRoutes({ query, auth }));
```

> 對照 `src/routes/me.js` 怎麼匯出（default 直接 router or factory），統一風格。

- [ ] **Step 6：commit**

```bash
git add src/routes/me-narrative.js src/app.js tests/me-narrative.test.js
git commit -m "feat(narrative): add GET /api/me/narrative mechanical endpoint"
```

---

## Task 4：narrative router — LLM insights endpoint

**Files:**
- Modify: `src/routes/me-narrative.js`（加第二個 handler）
- Modify: `tests/me-narrative.test.js`

- [ ] **Step 1：加 cache hit + no-key 測試**

```js
describe('GET /api/me/narrative/insights', () => {
  it('沒設 LLM_SWITCH_API_KEY 回 503', async () => {
    const app = await buildApp({
      query: fakeQuery({}),
      env: {},
    });
    const res = await request(app).get('/api/me/narrative/insights?range=14d');
    assert.equal(res.status, 503);
    assert.match(res.body.error, /LLM/);
  });

  it('資料 hash 一樣時走 cache、第二次不打 LLM', async () => {
    let calls = 0;
    const fakeLLM = async () => { calls++; return { summary_one_line: 'x', section_explanations: {}, project_friction: {}, insights_for_admin: [], next_actions: [] }; };
    const app = await buildApp({
      query: fakeQuery({ 'session_logs': [{ project_key: 'p', body: {} }] }),
      llmCall: fakeLLM,
      env: { LLM_SWITCH_API_KEY: 'sk-test' },
    });
    await request(app).get('/api/me/narrative/insights?range=14d');
    await request(app).get('/api/me/narrative/insights?range=14d');
    assert.equal(calls, 1, 'second call should hit cache');
  });

  it('LLM throw → 502 + 友善訊息', async () => {
    const app = await buildApp({
      query: fakeQuery({}),
      llmCall: async () => { throw new Error('upstream down'); },
      env: { LLM_SWITCH_API_KEY: 'sk-test' },
    });
    const res = await request(app).get('/api/me/narrative/insights?range=14d');
    assert.equal(res.status, 502);
  });
});
```

- [ ] **Step 2：跑測試確認 3 個新測試 fail**

- [ ] **Step 3：實作 insights handler**

```js
// 在 src/routes/me-narrative.js 內 createNarrativeRouter() 末尾加：
import { buildMessages, callLLMSwitch, computeDataHash } from '../lib/llm-narrative.js';
import { createNarrativeCache } from '../lib/narrative-cache.js';

// 在 createNarrativeRouter 參數加：
//   llmCall = ({apiKey, messages}) => callLLMSwitch({apiKey, messages})
//   cache = createNarrativeCache()
const insightsCache = cache || createNarrativeCache({ ttlMs: 3_600_000 });

router.get('/insights', async (req, res) => {
  const apiKey = env.LLM_SWITCH_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: '管理者尚未設定 LLM；機械版報告仍可用',
      code: 'no_api_key',
    });
  }
  try {
    const range = req.query.range || '14d';
    const days = parseRange(range);
    const sections = await collectSections({ query, days });
    const redacted = redactPIIDeep(sections);  // 見下方
    const hash = computeDataHash(redacted);
    const cacheKey = `${range}:${hash}`;
    const hit = insightsCache.get(cacheKey);
    if (hit) return res.json({ cached: true, ...hit });

    const messages = buildMessages(redacted);
    const fn = llmCall || (({ messages }) => callLLMSwitch({ apiKey, messages }));
    const result = await fn({ apiKey, messages });
    insightsCache.set(cacheKey, result);
    res.json({ cached: false, ...result });
  } catch (err) {
    console.error('narrative insights failed', err);
    res.status(502).json({
      error: '洞察暫時無法產生，稍後再試',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

function redactPIIDeep(obj) {
  // 簡版：把字串裡的 email + IPv4 改成 [redacted]
  const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
  function walk(v) {
    if (typeof v === 'string') return v.replace(EMAIL_RE, '[email]').replace(IP_RE, '[ip]');
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {}; for (const k of Object.keys(v)) out[k] = walk(v[k]); return out;
    }
    return v;
  }
  return walk(obj);
}
```

- [ ] **Step 4：跑測試確認 pass**

Run: `node --test tests/me-narrative.test.js`
Expected: all pass

- [ ] **Step 5：commit**

```bash
git add src/routes/me-narrative.js tests/me-narrative.test.js
git commit -m "feat(narrative): add GET /api/me/narrative/insights with hash cache + PII redaction"
```

---

## Task 5：Frontend — 加新 tab + 機械段 render

**Files:**
- Modify: `src/public/me/index.html`

- [ ] **Step 1：加 tab button 跟 div 容器**

找到既有 tab buttons（找 `data-tab="projects"`）旁加：

```html
<button data-tab="narrative">📊 敘事報告</button>
```

找到 `<div id="tab-projects">` 旁加：

```html
<div id="tab-narrative" class="tab-content">
  <div class="card">
    <h2>📊 團隊敘事報告</h2>
    <div id="narrative-summary" class="ai-explain">⏳ 產生洞察中…</div>
    <div id="narrative-sections"></div>
    <div id="narrative-actions" class="card" style="margin-top:1rem">
      <h3>給你的下一步動作</h3>
      <ol id="narrative-action-list"><li class="ai-explain">⏳ 產生中…</li></ol>
    </div>
  </div>
</div>
```

- [ ] **Step 2：加 tab switch handler**

找到既有 tab switch logic（搜 `data-tab`），加 narrative case 觸發 `loadNarrative()`。

- [ ] **Step 3：寫 loadNarrative()**

```js
let narrativeLoaded = false;
async function loadNarrative() {
  if (narrativeLoaded) return;
  narrativeLoaded = true;
  const range = $('#rangeSel').value || '14d';
  const key = localStorage.getItem(KEY_NAME);
  const headers = { 'Authorization': `Bearer ${key}` };

  // 平行 fetch 兩 endpoint
  const mechP = fetch(`/api/me/narrative?range=${range}`, { headers }).then(r => r.json());
  const insightP = fetch(`/api/me/narrative/insights?range=${range}`, { headers }).then(r => r.json()).catch(e => ({ _error: e.message }));

  const mech = await mechP;
  renderNarrativeMechanical(mech);

  const ins = await insightP;
  if (ins._error || ins.error) {
    document.querySelectorAll('.ai-explain').forEach(el => el.textContent = '（洞察暫時無法產生）');
    return;
  }
  renderNarrativeInsights(ins);
}
```

- [ ] **Step 4：寫 renderNarrativeMechanical(data)**

照 12 section 結構產 HTML（表格 + mermaid div）。每段加一個 `<div class="ai-explain" data-section="ranking">⏳ 產生洞察中…</div>` placeholder。

```js
function renderNarrativeMechanical(data) {
  const s = data.sections;
  const root = document.getElementById('narrative-sections');
  root.innerHTML = `
    <h3>1. 誰最常用 OwnMind</h3>
    ${renderRankingTable(s.ranking)}
    <div class="ai-explain" data-section="ranking">⏳ 產生洞察中…</div>

    <h3>2. 大家的軟體版本</h3>
    ${renderVersionsTable(s.versions, s.ranking)}
    <div class="ai-explain" data-section="versions">⏳ 產生洞察中…</div>

    <h3>3. 哪幾天最忙</h3>
    <pre class="mermaid">${renderDailyChart(s.daily)}</pre>
    <div class="ai-explain" data-section="daily">⏳ 產生洞察中…</div>

    <h3>4. 一天裡哪個時段最忙</h3>
    <pre class="mermaid">${renderHourlyChart(s.hourly)}</pre>
    <div class="ai-explain" data-section="hourly">⏳ 產生洞察中…</div>

    <h3>5. 一週各天分布</h3>
    <pre class="mermaid">${renderWeekdayChart(s.weekday)}</pre>
    <div class="ai-explain" data-section="weekday">⏳ 產生洞察中…</div>

    <h3>6. 大家都在做什麼類型的事</h3>
    ${renderEventTypesTable(s.event_types)}
    <div class="ai-explain" data-section="event_types">⏳ 產生洞察中…</div>

    <h3>7. 鐵律有沒有被遵守</h3>
    ${renderComplianceTable(s.compliance)}
    <div class="ai-explain" data-section="compliance">⏳ 產生洞察中…</div>

    <h3>8. 軟體更新有沒有失敗</h3>
    ${renderUpdateHealthTable(s.update_health)}
    <div class="ai-explain" data-section="update_health">⏳ 產生洞察中…</div>

    <h3>9. 各專案活動量排行</h3>
    ${renderProjectRankingTable(s.project_ranking)}
    <div class="ai-explain" data-section="project_ranking">⏳ 產生洞察中…</div>

    <h3>10. 各專案最常踩什麼坑</h3>
    <div id="project-friction-render"><em style="color:#9ca3af">⏳ 萃取中…</em></div>

    <h3>11. 各專案守了哪些鐵律</h3>
    ${renderProjectComplianceTable(s.project_compliance)}
    <div class="ai-explain" data-section="project_compliance">⏳ 產生洞察中…</div>

    <h3>12. 給管理者的洞察</h3>
    <ol id="narrative-insight-list"><li class="ai-explain">⏳ 產生中…</li></ol>
  `;
  if (window.mermaid) window.mermaid.run({ querySelector: '#tab-narrative .mermaid' });
}
```

> NOTE：renderRankingTable 等 helper 自己寫，照現有 me page table style。renderDailyChart 回傳 `xychart-beta\n title ...\n x-axis [...]\n y-axis ...\n bar [...]`。

- [ ] **Step 5：寫 renderNarrativeInsights(ins)**

```js
function renderNarrativeInsights(ins) {
  document.getElementById('narrative-summary').textContent = ins.summary_one_line || '';

  for (const [section, text] of Object.entries(ins.section_explanations || {})) {
    const el = document.querySelector(`.ai-explain[data-section="${section}"]`);
    if (el) el.textContent = text;
  }

  const fricRoot = document.getElementById('project-friction-render');
  fricRoot.innerHTML = Object.entries(ins.project_friction || {}).map(([proj, items]) => `
    <h4>${esc(proj)}</h4>
    <ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
  `).join('') || '<em style="color:#9ca3af">無資料</em>';

  document.getElementById('narrative-insight-list').innerHTML =
    (ins.insights_for_admin || []).map(t => `<li>${esc(t)}</li>`).join('');
  document.getElementById('narrative-action-list').innerHTML =
    (ins.next_actions || []).map(t => `<li>${esc(t)}</li>`).join('');
}
```

- [ ] **Step 6：載入 mermaid CDN（若 me page 還沒有）**

在 `<head>` 確認有：
```html
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
  mermaid.initialize({ startOnLoad: false });
  window.mermaid = mermaid;
</script>
```

- [ ] **Step 7：手動驗測（IR-020）— 部署前先本機跑**

```bash
npm start  # 本機端啟動
# 開 http://localhost:<port>/me 切到敘事報告 tab
# 預期：12 section 機械段秒出、洞察 placeholder 在跑、3-15 秒後白話講插入、無 console error
```

- [ ] **Step 8：commit**

```bash
git add src/public/me/index.html
git commit -m "feat(narrative): add /me 敘事報告 tab — auto-trigger LLM insights on page open"
```

---

## Task 6：env example + production secret

**Files:**
- Modify: `.env.example`

- [ ] **Step 1：加 env example 註記**

```bash
# .env.example 末尾加：
# LLM Switch — 用於 /me 敘事報告 LLM 洞察
# 管理者請到 https://example.com/llm-switch/dashboard 申請 key
LLM_SWITCH_API_KEY=
```

- [ ] **Step 2：commit**

```bash
git add .env.example
git commit -m "chore: document LLM_SWITCH_API_KEY in .env.example"
```

- [ ] **Step 3（部署時人工）：到 example.com 主機 `.env` 加真 key**

```bash
ssh <prod-host> 'echo "LLM_SWITCH_API_KEY=<從 user 對話拿到的 key>" >> /path/to/ownmind/.env'
# 然後 docker compose build --no-cache && docker compose up -d
```

> **不要把真 key 寫進這個 plan、commit、CHANGELOG**。Plan 寫到這裡為止，實際 key 由 Vin 手動填。

---

## Task 7：版號 + docs（IR-031 / IR-008 / IR-032）

**Files:**
- Modify: `package.json`、`README.md`、`docs/README.zh-TW.md`、`docs/README.ja.md`、`CHANGELOG.md`、`FILELIST.md`

- [ ] **Step 1：bump 版號**

```
package.json:                   1.17.46 → 1.17.47
README.md (line 5):             v1.17.46 → v1.17.47
docs/README.zh-TW.md (line 5):  v1.17.46 → v1.17.47
docs/README.ja.md (line 5):     v1.17.46 → v1.17.47
```

- [ ] **Step 2：CHANGELOG 加 v1.17.47 條目**

```md
## v1.17.47 — /me 敘事報告（HackMD 風格 14 天分析）

新增 `/ownmind/me` 第四個 tab「📊 敘事報告」：12 段團隊使用分析。

**機械段（秒回）**
人員排行 / 版本對照 / 日時週分布 / 動作類型 / 鐵律 / 更新健康度 / 專案排行 / 各專案合規。

**LLM 段（開頁自動觸發、server cache 1hr）**
- 一句話結論 + 各段「白話講」 + 給管理者的洞察 + 下一步動作 + 各專案踩坑萃取
- 走 llm-switch（OpenAI-compatible），model='auto'，response_format=json_object
- Server 端 cache by sha256(narrative_data)，TTL 1hr，全團隊每 range 每小時最多打 1 次 LLM
- friction notes 給 LLM 前 redactPII（email / IP）

**新檔**
- src/lib/llm-narrative.js — llm-switch wrapper
- src/lib/narrative-cache.js — in-memory hash cache
- src/routes/me-narrative.js — 兩個 endpoint
- tests/{narrative-cache,llm-narrative,me-narrative}.test.js

**設定**
管理者需在 production `.env` 加 `LLM_SWITCH_API_KEY`。沒 key 時 endpoint 回 503，機械版仍可用。
```

- [ ] **Step 3：FILELIST 加條目**

```md
## v1.17.47 修改（/me 敘事報告）

\`\`\`
src/lib/llm-narrative.js                   — 新增（llm-switch wrapper）
src/lib/narrative-cache.js                 — 新增（hash cache）
src/routes/me-narrative.js                 — 新增（mechanical + insights endpoints）
src/app.js                                 — mount /api/me/narrative router
src/public/me/index.html                   — 加第 4 tab + 12 section render + auto LLM
.env.example                               — 補 LLM_SWITCH_API_KEY 註記
tests/narrative-cache.test.js              — 新增
tests/llm-narrative.test.js                — 新增
tests/me-narrative.test.js                 — 新增
package.json / README* / docs/README*      — 1.17.46 → 1.17.47
CHANGELOG.md                               — v1.17.47 條目
\`\`\`
```

- [ ] **Step 4：跑全測**

```bash
node --test tests/
```
Expected: all green

- [ ] **Step 5：commit**

```bash
git add package.json README.md docs/README.zh-TW.md docs/README.ja.md CHANGELOG.md FILELIST.md
git commit -m "docs: bump 1.17.46 → 1.17.47 + 敘事報告條目"
```

---

## Task 8：品管三步驟 + 部署

依 IR-045（品管三步驟）+ IR-020（部署後瀏覽器實測）+ IR-018/023（docker compose build --no-cache）。

- [ ] **Step 1：verification-before-completion**

```
node --test tests/                  # 全測過
git status                          # 沒有忘記 add 的檔
```

- [ ] **Step 2：requesting-code-review**

調用 superpowers:requesting-code-review skill 對本 branch 跑一輪。

- [ ] **Step 3：把真的 LLM_SWITCH_API_KEY 補到 production `.env`**

```bash
ssh <prod-host>
cd /path/to/ownmind
echo "LLM_SWITCH_API_KEY=<key>" >> .env  # 從這次對話拿、不入 git
docker compose build --no-cache
docker compose up -d
docker compose logs -f --tail=50  # 確認起得來
```

- [ ] **Step 4：瀏覽器實測（IR-020）**

到 https://example.com/ownmind/me：
- [ ] 切到「📊 敘事報告」tab，12 section 機械段是否都 render
- [ ] 看是否「⏳ 產生洞察中…」placeholder 在跑
- [ ] 3-15 秒後白話講是否填入
- [ ] reload 頁面，是否秒回（cache hit）
- [ ] 開 DevTools console 看有沒有 error
- [ ] 切換 range（14d / 30d）能否重新觸發

- [ ] **Step 5：rotate API key**

提醒 Vin 到 https://example.com/llm-switch dashboard rotate 之前在 conversation 貼出來的 key，然後改 production `.env` + restart。

- [ ] **Step 6：完工 commit + push（已透過前述 task 累積，這步只是確認）**

```bash
git log --oneline | head -10
git push origin main
```

---

## Self-Review

| 檢查項 | 結果 |
|--------|------|
| Spec 12 個 section 都有對應 task？ | ✅ Task 3 + 5 涵蓋 |
| LLM endpoint 沒 key 行為？ | ✅ Task 4 step 1 第 1 個測試 |
| Server cache by hash？ | ✅ Task 1 + Task 4 step 1 第 2 個測試 |
| Auto-trigger on page open？ | ✅ Task 5 step 3 平行 fetch |
| PII redact？ | ✅ Task 4 step 3 redactPIIDeep |
| 版號 / docs 三語？ | ✅ Task 7 |
| IR-020 瀏覽器實測？ | ✅ Task 8 step 4 |
| API key 不入 commit？ | ✅ Task 6 + Task 8 step 3 都明示 |
| Placeholder 掃描 | ✅ 無 TBD/TODO/「適當的」之類字眼 |
| 型別一致 | ✅ section keys 在 spec/router/frontend 三處對齊 |

唯一已知 gap：Task 3 的 SQL `column / table 名稱`需對照本 repo 真實 schema 微調（部分用了 `client_heartbeats` / `web_users.deleted_at` 這類，實作前需先 `\d` 確認）。實作 task 3 step 3 時 grep `me.js` 拿真實 SQL 範本即可。
