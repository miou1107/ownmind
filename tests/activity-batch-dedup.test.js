import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Router } from 'express';

/**
 * v1.17.98 — POST /api/activity/batch dedup 測試
 *
 * 直接 stub query 函式驗證 SQL 行為：
 *   - INSERT 含 client_event_id 欄位
 *   - 用 ON CONFLICT (user_id, client_event_id) WHERE client_event_id IS NOT NULL DO NOTHING
 *   - 沒帶 client_event_id 的事件 → NULL、不會被 unique index 卡（partial index）
 *   - 重複 client_event_id → server 跳過、回 deduped 計數
 *   - 非合法 UUID v4 → 當 NULL 處理（防 client 亂塞 string）
 */

// 模擬 PG row format
function ok(rows) { return { rows }; }

/**
 * 把假 query 注入 router 用的 query function
 *   state.inserted: 已存的 (user_id, client_event_id) 集合（模擬 unique index）
 *   state.captured: 每次 INSERT 的 SQL + params（給斷言檢查）
 */
function makeFakeQuery(state) {
  return async (sql, params) => {
    if (/INSERT INTO activity_logs/.test(sql)) {
      state.captured.push({ sql, params });
      // v1.17.98 兩條 path：
      //   無 ON CONFLICT 子句 → 一定 insert（NULL client_event_id path）
      //   有 ON CONFLICT 子句 → 第 7 個 param 是 client_event_id、模擬 partial unique
      const hasOnConflict = /ON CONFLICT/.test(sql);
      if (!hasOnConflict) {
        return ok([{ id: state.captured.length }]);
      }
      const clientId = params[6];
      if (state.inserted.has(`${params[0]}::${clientId}`)) {
        return ok([]);  // ON CONFLICT DO NOTHING → RETURNING 0 rows
      }
      state.inserted.add(`${params[0]}::${clientId}`);
      return ok([{ id: state.captured.length }]);
    }
    // memoryLookup 返回 null 讓 enrich 走 fallback
    if (/SELECT type, code, title FROM memories/.test(sql)) {
      return ok([]);
    }
    return ok([]);
  };
}

/**
 * 建一個只掛 batch 路由的 mini app，注入 fake query
 */
async function buildApp(state) {
  // 動態 import 因為需要先注入 mock
  const { default: enrichMod } = await import('../src/utils/enrich-activity.js')
    .then(m => ({ default: m })).catch(() => ({ default: null }));

  const router = Router();
  const fakeAuth = (req, _res, next) => { req.user = { id: 1 }; next(); };
  const fakeQuery = makeFakeQuery(state);

  // 簡化版 handler — 對應 src/routes/activity.js batch handler 的 dedup 邏輯
  // ⚠️ 這是 simplified copy、不是真的 import 真 handler（review I1 limitation：
  // src/routes/activity.js 用 module-level Router、無法注入 query mock；
  // 真 handler 跟 module-level pg client 緊耦合、整合測試需要 refactor 成 factory pattern）
  // 這條 simplified copy 必須跟 src/routes/activity.js batch handler 的 dedup 路徑邏輯
  // 完全相同；改 server handler 時記得同步改這裡。
  //
  // v1.17.98 review B1 修正：拆兩條 path — clientEventId === null 走純 INSERT、
  // 有 id 才走 ON CONFLICT 避免 partial index inference 邊界 bug。
  const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  router.post('/batch', fakeAuth, async (req, res) => {
    const { events } = req.body;
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'empty' });
    }
    let inserted = 0, deduped = 0;
    for (const e of events) {
      if (!e.ts || !e.event) continue;
      const clientEventId = (typeof e.client_event_id === 'string' && UUID_V4_REGEX.test(e.client_event_id))
        ? e.client_event_id : null;
      let r;
      if (clientEventId === null) {
        r = await fakeQuery(
          `INSERT INTO activity_logs (user_id, ts, event, tool, source, details)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [req.user.id, e.ts, e.event, e.tool || null, e.source || null, e.details || {}]
        );
      } else {
        r = await fakeQuery(
          `INSERT INTO activity_logs (user_id, ts, event, tool, source, details, client_event_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, client_event_id) WHERE client_event_id IS NOT NULL
           DO NOTHING RETURNING id`,
          [req.user.id, e.ts, e.event, e.tool || null, e.source || null, e.details || {}, clientEventId]
        );
      }
      if (r.rows.length === 0) deduped++; else inserted++;
    }
    res.json({ inserted, deduped, total: events.length });
  });

  const app = express();
  app.use(express.json());
  app.use('/api/activity', router);
  return app;
}

async function postBatch(app, events) {
  return new Promise((resolve, reject) => {
    const req = {
      method: 'POST', url: '/api/activity/batch', path: '/api/activity/batch',
      headers: { 'content-type': 'application/json' },
      body: { events },
    };
    const res = {
      statusCode: 200, _h: {},
      setHeader(k,v){ this._h[k]=v; }, getHeader(k){ return this._h[k]; },
      status(c){ this.statusCode = c; return this; },
      json(p){ resolve({ status: this.statusCode, body: p }); },
      send(p){ resolve({ status: this.statusCode, body: p }); },
      end(){ resolve({ status: this.statusCode, body: null }); }
    };
    try { app.handle(req, res, e => e ? reject(e) : resolve({ status: res.statusCode })); }
    catch (e) { reject(e); }
  });
}

describe('v1.17.98 — POST /api/activity/batch client_event_id dedup', () => {
  it('有 client_event_id 時 — SQL 含欄位 + ON CONFLICT 子句', async () => {
    const state = { inserted: new Set(), captured: [] };
    const app = await buildApp(state);
    const id = '11111111-2222-4333-8444-555555555555';
    await postBatch(app, [{ ts: '2026-05-13T00:00:00Z', event: 'iron_rule_compliance', client_event_id: id }]);

    assert.equal(state.captured.length, 1);
    assert.match(state.captured[0].sql, /client_event_id/, 'SQL 必須含 client_event_id 欄位');
    assert.match(state.captured[0].sql, /ON CONFLICT[\s\S]*client_event_id[\s\S]*DO NOTHING/i,
      'SQL 必須有 ON CONFLICT DO NOTHING 子句');
    assert.match(state.captured[0].sql, /WHERE client_event_id IS NOT NULL/i,
      'ON CONFLICT 必須限定 client_event_id IS NOT NULL（partial unique index）');
    assert.equal(state.captured[0].params[6], id, '第 7 個 param 必須是 client_event_id');
  });

  // v1.17.98 review B1 — NULL client_event_id 必須走純 INSERT、不能帶 ON CONFLICT
  it('沒帶 client_event_id 時 — SQL 不該帶 ON CONFLICT 子句（避免 partial index inference 邊界）', async () => {
    const state = { inserted: new Set(), captured: [] };
    const app = await buildApp(state);
    await postBatch(app, [{ ts: '2026-05-13T00:00:00Z', event: 'memory_save' }]);

    assert.equal(state.captured.length, 1);
    assert.ok(!/ON CONFLICT/.test(state.captured[0].sql),
      'NULL client_event_id 必須走純 INSERT、不帶 ON CONFLICT — 即使理論上 partial index 該排除 NULL row、保守起見不依賴 inference 邊界');
    assert.ok(!/client_event_id/.test(state.captured[0].sql),
      'NULL path 也不該寫 client_event_id 欄位（讓 DB default NULL）');
    assert.equal(state.captured[0].params.length, 6, 'NULL path 應該只有 6 個 params');
  });

  it('合法 UUID v4 重複送 → 第二次 dedup、回 deduped=1', async () => {
    const state = { inserted: new Set(), captured: [] };
    const app = await buildApp(state);
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const ev = { ts: '2026-05-13T00:00:00Z', event: 'iron_rule_compliance', client_event_id: id };

    const r1 = await postBatch(app, [ev]);
    assert.equal(r1.body.inserted, 1);
    assert.equal(r1.body.deduped, 0);

    const r2 = await postBatch(app, [ev]);
    assert.equal(r2.body.inserted, 0, '第二次同 id 必須被 dedup');
    assert.equal(r2.body.deduped, 1);
  });

  it('沒帶 client_event_id（舊 client）→ 走純 INSERT path、每次都 insert', async () => {
    const state = { inserted: new Set(), captured: [] };
    const app = await buildApp(state);
    const ev = { ts: '2026-05-13T00:00:00Z', event: 'iron_rule_compliance' };

    const r1 = await postBatch(app, [ev]);
    const r2 = await postBatch(app, [ev]);
    assert.equal(r1.body.inserted, 1);
    assert.equal(r2.body.inserted, 1, '沒帶 client_event_id 的事件不該被 dedup');
    // NULL path：純 INSERT、不帶 ON CONFLICT、不寫 client_event_id 欄位
    assert.ok(!/ON CONFLICT/.test(state.captured[0].sql));
    assert.equal(state.captured[0].params.length, 6);
  });

  it('非合法 UUID 字串（亂塞）→ 走純 INSERT path（當 NULL）', async () => {
    const state = { inserted: new Set(), captured: [] };
    const app = await buildApp(state);
    const ev = { ts: '2026-05-13T00:00:00Z', event: 'x', client_event_id: 'not-a-real-uuid' };

    await postBatch(app, [ev]);
    await postBatch(app, [ev]);
    assert.ok(!/ON CONFLICT/.test(state.captured[0].sql), '非合法 UUID 必須走純 INSERT path');
    assert.equal(state.captured[0].params.length, 6);
  });

  it('UUID v1（非 v4）→ 走純 INSERT path（regex 限定 v4）', async () => {
    const state = { inserted: new Set(), captured: [] };
    const app = await buildApp(state);
    const v1 = '11111111-2222-1111-8444-555555555555';
    await postBatch(app, [{ ts: '2026-05-13T00:00:00Z', event: 'x', client_event_id: v1 }]);
    assert.ok(!/ON CONFLICT/.test(state.captured[0].sql),
      '只接受 v4 UUID（dedup 來源是 crypto.randomUUID）');
    assert.equal(state.captured[0].params.length, 6);
  });

  it('混合 batch — 有 id + 沒 id 各 1 條 → 各走各的 path', async () => {
    const state = { inserted: new Set(), captured: [] };
    const app = await buildApp(state);
    const id = 'cccccccc-dddd-4eee-8fff-000000000000';
    const r = await postBatch(app, [
      { ts: '2026-05-13T00:00:00Z', event: 'a', client_event_id: id },
      { ts: '2026-05-13T00:00:00Z', event: 'b' },
    ]);
    assert.equal(r.body.inserted, 2);
    assert.equal(r.body.deduped, 0);
    assert.match(state.captured[0].sql, /ON CONFLICT/, '有 id 的事件走 ON CONFLICT path');
    assert.equal(state.captured[0].params[6], id);
    assert.ok(!/ON CONFLICT/.test(state.captured[1].sql), '沒 id 的事件走純 INSERT path');
    assert.equal(state.captured[1].params.length, 6);
  });

  it('batch 內同 id 重複 → 第二筆 dedup', async () => {
    const state = { inserted: new Set(), captured: [] };
    const app = await buildApp(state);
    const id = 'eeeeeeee-ffff-4111-8222-333333333333';
    const r = await postBatch(app, [
      { ts: '2026-05-13T00:00:00Z', event: 'a', client_event_id: id },
      { ts: '2026-05-13T00:00:00Z', event: 'a', client_event_id: id },
    ]);
    assert.equal(r.body.inserted, 1);
    assert.equal(r.body.deduped, 1);
  });
});
