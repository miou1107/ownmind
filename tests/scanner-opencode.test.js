import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { createOpenCodeAdapter, buildEventFromRow } =
  await import('../shared/scanners/opencode.js');

// ────────────────────────────────────────────────────────────
// buildEventFromRow — pure
// ────────────────────────────────────────────────────────────

function assistantRow(id, sessionId, timeCreated, tokens, extra = {}) {
  return {
    id, session_id: sessionId, time_created: timeCreated,
    data: JSON.stringify({
      role: 'assistant',
      time: { created: timeCreated, completed: timeCreated + 1000 },
      modelID: 'big-pickle',
      cost: 0.0123,
      tokens,
      ...extra
    })
  };
}

describe('buildEventFromRow', () => {
  it('parses assistant row into Tier 1 event', () => {
    const row = assistantRow('msg_abc', 'sess-1', 1772435795982,
      { total: 200, input: 78, output: 132, reasoning: 0, cache: { read: 510, write: 11167 } });
    const e = buildEventFromRow(row, {});
    assert.equal(e.tool, 'opencode');
    assert.equal(e.message_id, 'msg_abc');
    assert.equal(e.session_id, 'sess-1');
    assert.equal(e.model, 'big-pickle');
    assert.equal(e.input_tokens, 78);
    assert.equal(e.output_tokens, 132);
    assert.equal(e.cache_creation_tokens, 11167);
    assert.equal(e.cache_read_tokens, 510);
    assert.equal(e.reasoning_tokens, 0);
    assert.equal(e.native_cost_usd, 0.0123);
    // 1st event for session → cumulative = sum of all tokens
    assert.equal(e.cumulative_total_tokens, 78 + 132 + 0 + 510 + 11167);
    assert.match(e.ts, /^2026-/);  // iso date from ms
  });

  it('accumulates cumulative on top of prev session total', () => {
    const row = assistantRow('msg_b', 'sess-1', 1772435800000,
      { total: 20, input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } });
    const e = buildEventFromRow(row, { 'sess-1': 1000 });
    // prev 1000 + (10 + 10 + 0 + 0 + 0) = 1020
    assert.equal(e.cumulative_total_tokens, 1020);
  });

  it('returns null for non-assistant rows', () => {
    const row = {
      id: 'msg_x', session_id: 's', time_created: 1, data: JSON.stringify({ role: 'user' })
    };
    assert.equal(buildEventFromRow(row, {}), null);
  });

  it('returns null when data lacks tokens', () => {
    const row = {
      id: 'msg_x', session_id: 's', time_created: 1,
      data: JSON.stringify({ role: 'assistant', time: { created: 1 } })
    };
    assert.equal(buildEventFromRow(row, {}), null);
  });

  it('returns null on malformed JSON', () => {
    const row = { id: 'x', session_id: 's', time_created: 1, data: 'not-json' };
    const logs = [];
    const logger = { warn: (m) => logs.push(m) };
    assert.equal(buildEventFromRow(row, {}, { logger }), null);
    assert.equal(logs.length, 1, 'logger.warn 應被呼叫');
  });
});

// ────────────────────────────────────────────────────────────
// Adapter.readSince — via injected runSqlite mock
// ────────────────────────────────────────────────────────────

function makeFakeSqlite(rows, { captureSql } = {}) {
  return async ({ sql }) => {
    captureSql?.(sql);
    return rows;
  };
}

describe('createOpenCodeAdapter.readSince', () => {
  it('composite cursor — empty state yields empty cursor clauses', async () => {
    const captured = [];
    const adapter = createOpenCodeAdapter({
      runSqlite: makeFakeSqlite([], { captureSql: (s) => captured.push(s) })
    });
    await adapter.readSince({});
    const sql = captured[0];
    assert.match(sql, /time_created > 0/);
    assert.match(sql, /id > ''/);
  });

  it('composite cursor — next scan uses stored high_water (time, id)', async () => {
    const captured = [];
    const adapter = createOpenCodeAdapter({
      runSqlite: makeFakeSqlite([], { captureSql: (s) => captured.push(s) })
    });
    await adapter.readSince({
      opencode: { high_water_time: 12345, high_water_id: 'msg_abc' }
    });
    const sql = captured[0];
    assert.match(sql, /time_created > 12345/);
    assert.match(sql, /id > 'msg_abc'/);
  });

  it('numeric time comparison — prior scan at time=9 does not skip time=10', async () => {
    // 這是 spec P5 特別強調的字典序 bug 防範
    const captured = [];
    const adapter = createOpenCodeAdapter({
      runSqlite: makeFakeSqlite([], { captureSql: (s) => captured.push(s) })
    });
    await adapter.readSince({
      opencode: { high_water_time: 9, high_water_id: 'msg_x' }
    });
    assert.match(captured[0], /time_created > 9/);
    // 若是字串比較會變成 `time_created > '9'` 把 time=10 誤判為已讀
    assert.doesNotMatch(captured[0], /time_created > '9'/);
  });

  it('interleaved sessions — each session maintains independent cumulative', async () => {
    // global order: A@1(10), B@2(100), A@3(10), B@4(100), A@5(10)
    // sess A cumulative trail: 10 → 20 → 30
    // sess B cumulative trail: 100 → 200
    const rows = [
      assistantRow('m1', 'A', 1, { total: 10, input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
      assistantRow('m2', 'B', 2, { total: 100, input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
      assistantRow('m3', 'A', 3, { total: 10, input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
      assistantRow('m4', 'B', 4, { total: 100, input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
      assistantRow('m5', 'A', 5, { total: 10, input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    ];
    const adapter = createOpenCodeAdapter({ runSqlite: makeFakeSqlite(rows) });
    const r = await adapter.readSince({});
    assert.equal(r.events.length, 5);
    // session A 的三筆 cumulative 依序 10/20/30（不被 B 干擾）
    const sessionACums = r.events.filter((e) => e.session_id === 'A')
      .map((e) => e.cumulative_total_tokens);
    assert.deepEqual(sessionACums, [10, 20, 30],
      'session A 各自累加，不因 B 切換 reset');
    const sessionBCums = r.events.filter((e) => e.session_id === 'B')
      .map((e) => e.cumulative_total_tokens);
    assert.deepEqual(sessionBCums, [100, 200]);
    // cumulative patch 只保留 A、B 的最終值
    assert.equal(r.cumulativePatch.A, 30);
    assert.equal(r.cumulativePatch.B, 200);
  });

  it('session_cumulative survives scanner restart', async () => {
    const rows = [
      assistantRow('m1', 'A', 1, { total: 5, input: 5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    ];
    const adapter = createOpenCodeAdapter({ runSqlite: makeFakeSqlite(rows) });
    const r = await adapter.readSince({
      session_cumulative: { opencode: { A: 1000 } }  // 假設重啟前 A 已累到 1000
    });
    assert.equal(r.events[0].cumulative_total_tokens, 1005, '1000 + 5');
  });

  it('offsetPatch records last (time_created, id) seen', async () => {
    const rows = [
      assistantRow('msg_a', 'S', 100, { total: 1, input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
      assistantRow('msg_b', 'S', 200, { total: 1, input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    ];
    const adapter = createOpenCodeAdapter({ runSqlite: makeFakeSqlite(rows) });
    const r = await adapter.readSince({});
    assert.equal(r.offsetPatch.opencode.high_water_time, 200);
    assert.equal(r.offsetPatch.opencode.high_water_id, 'msg_b');
  });

  it('no rows → no offsetPatch (cursor unchanged)', async () => {
    const adapter = createOpenCodeAdapter({ runSqlite: makeFakeSqlite([]) });
    const r = await adapter.readSince({
      opencode: { high_water_time: 100, high_water_id: 'x' }
    });
    assert.deepEqual(r.offsetPatch, {}, 'empty scan should not rewrite cursor');
  });

  it('sqlite error → returns empty scan + warning (does not throw)', async () => {
    const logs = [];
    const adapter = createOpenCodeAdapter({
      runSqlite: async () => { throw new Error('db locked'); },
      logger: { warn: (m) => logs.push(m) }
    });
    const r = await adapter.readSince({});
    assert.deepEqual(r.events, []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /db locked/);
  });

  it('ENOENT gets distinct message naming sqlite3 CLI', async () => {
    const logs = [];
    const adapter = createOpenCodeAdapter({
      sqlitePath: '/nonexistent/sqlite3',
      runSqlite: async () => {
        const e = new Error('spawn sqlite3 ENOENT');
        e.code = 'ENOENT';
        throw e;
      },
      logger: { warn: (m) => logs.push(m) }
    });
    const r = await adapter.readSince({});
    assert.deepEqual(r.events, []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /sqlite3 CLI not found/);
    assert.match(logs[0], /'\/nonexistent\/sqlite3'/);
  });

  it("SQL injection defense — high_water_id containing '' escape handled", async () => {
    const captured = [];
    const adapter = createOpenCodeAdapter({
      runSqlite: makeFakeSqlite([], { captureSql: (s) => captured.push(s) })
    });
    await adapter.readSince({
      opencode: { high_water_time: 1, high_water_id: "msg_a'; DROP TABLE message;--" }
    });
    // sqlQuote 應該把 ' escape 為 ''，整個 cursor 還是 string literal
    assert.match(captured[0], /id > 'msg_a''; DROP TABLE message;--'/);
  });
});
