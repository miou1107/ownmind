import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { writeSafetyAudit } = await import('../src/utils/safety-audit.js');

function makeQuery(insertCalls = []) {
  return async (sql, params) => {
    insertCalls.push({ sql, params });
    return { rows: [{ id: 1 }], rowCount: 1 };
  };
}

function makeFailingQuery(err = new Error('db down')) {
  return async () => { throw err; };
}

describe('writeSafetyAudit - 合法 event_type', () => {
  it('cross_user_access → 寫入 usage_audit_log', async () => {
    const insertCalls = [];
    const r = await writeSafetyAudit({
      query: makeQuery(insertCalls),
      userId: 7,
      tool: 'claude-code',
      eventType: 'cross_user_access',
      details: { offending_user_ids: [2, 3], count: 2 },
    });
    assert.equal(r.written, true);
    assert.equal(insertCalls.length, 1);
    const { sql, params } = insertCalls[0];
    assert.match(sql, /INSERT INTO usage_audit_log/);
    assert.equal(params[0], 7);
    assert.equal(params[1], 'claude-code');
    assert.equal(params[2], 'cross_user_access');
    const detailsParsed = JSON.parse(params[3]);
    assert.deepEqual(detailsParsed.offending_user_ids, [2, 3]);
  });

  it('private_memory_leak → 寫入', async () => {
    const insertCalls = [];
    const r = await writeSafetyAudit({
      query: makeQuery(insertCalls),
      userId: 1, tool: null,
      eventType: 'private_memory_leak',
      details: {},
    });
    assert.equal(r.written, true);
    assert.equal(insertCalls[0].params[1], null);
  });

  it('secret_value_in_logs → 寫入', async () => {
    const insertCalls = [];
    const r = await writeSafetyAudit({
      query: makeQuery(insertCalls),
      userId: 1, tool: 'mcp',
      eventType: 'secret_value_in_logs',
      details: { matched_count: 2 },
    });
    assert.equal(r.written, true);
  });

  it('bulk_read_alert → 寫入', async () => {
    const insertCalls = [];
    const r = await writeSafetyAudit({
      query: makeQuery(insertCalls),
      userId: 1, tool: null,
      eventType: 'bulk_read_alert',
      details: { count: 1500, threshold: 1000, window_hours: 1 },
    });
    assert.equal(r.written, true);
  });
});

describe('writeSafetyAudit - 拒絕非法輸入', () => {
  it('未知 event_type → 不寫、回 unknown_event_type', async () => {
    const insertCalls = [];
    const r = await writeSafetyAudit({
      query: makeQuery(insertCalls),
      userId: 1, tool: null,
      eventType: 'random_event',
      details: {},
    });
    assert.equal(r.written, false);
    assert.equal(r.reason, 'unknown_event_type');
    assert.equal(insertCalls.length, 0);
  });

  it('userId 是字串 → 不寫、回 invalid_user_id', async () => {
    const insertCalls = [];
    const r = await writeSafetyAudit({
      query: makeQuery(insertCalls),
      userId: '7', tool: null,
      eventType: 'cross_user_access',
      details: {},
    });
    assert.equal(r.written, false);
    assert.equal(r.reason, 'invalid_user_id');
  });

  it('userId 是 0 / 負數 → 不寫', async () => {
    const insertCalls = [];
    const r1 = await writeSafetyAudit({
      query: makeQuery(insertCalls), userId: 0, tool: null,
      eventType: 'cross_user_access', details: {},
    });
    const r2 = await writeSafetyAudit({
      query: makeQuery(insertCalls), userId: -1, tool: null,
      eventType: 'cross_user_access', details: {},
    });
    assert.equal(r1.written, false);
    assert.equal(r2.written, false);
  });
});

describe('writeSafetyAudit - DB 失敗不拋（保護主流程）', () => {
  it('query 拋錯 → 回 written:false reason:db_error、不 escalate', async () => {
    let returned;
    await assert.doesNotReject(async () => {
      returned = await writeSafetyAudit({
        query: makeFailingQuery(),
        userId: 1, tool: null,
        eventType: 'cross_user_access',
        details: {},
      });
    });
    assert.equal(returned.written, false);
    assert.equal(returned.reason, 'db_error');
  });
});

describe('writeSafetyAudit - details 防呆', () => {
  it('details 是 undefined → 寫入空物件 {}', async () => {
    const insertCalls = [];
    await writeSafetyAudit({
      query: makeQuery(insertCalls),
      userId: 1, tool: null,
      eventType: 'cross_user_access',
      // 沒傳 details
    });
    assert.equal(insertCalls[0].params[3], '{}');
  });

  it('details 是 null → 寫入空物件 {}', async () => {
    const insertCalls = [];
    await writeSafetyAudit({
      query: makeQuery(insertCalls),
      userId: 1, tool: null,
      eventType: 'cross_user_access',
      details: null,
    });
    assert.equal(insertCalls[0].params[3], '{}');
  });
});
