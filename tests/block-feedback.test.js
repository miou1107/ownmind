import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { handleBlockFeedback } = await import('../src/lib/block-feedback.js');
const { deriveSecret, dayBucket, signFeedback } = await import('../src/utils/feedback-sig.js');

const TEST_KEY = 'test-encryption-key';
const SECRET = deriveSecret(TEST_KEY);
const NOW = new Date('2026-05-14T12:00:00Z').getTime();
const TODAY = dayBucket(NOW);
const EVENT_ID = 'evt_abc_xyz_123';
const USER_ID = 7;

/**
 * 建一個可控制行為的 fake query function。
 * fixtures: { eventExists, dupExists, insertCalls (in-out array) }
 */
function makeQuery({ eventExists = true, dupExists = false, insertCalls = [] } = {}) {
  return async (sql, params) => {
    if (sql.includes('FROM activity_logs') && sql.includes('client_event_id = $1 AND user_id = $2')) {
      return { rows: eventExists ? [{ id: 999 }] : [], rowCount: eventExists ? 1 : 0 };
    }
    if (sql.includes("event = 'block_feedback'") && sql.includes("details->>'original_event_id'")) {
      return { rows: dupExists ? [{ id: 888 }] : [], rowCount: dupExists ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO activity_logs')) {
      insertCalls.push({ sql, params });
      return { rows: [{ id: 1 }], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  };
}

describe('handleBlockFeedback - 校驗 event_id', () => {
  it('缺 event_id → 400', async () => {
    const r = await handleBlockFeedback({ body: {}, query: makeQuery(), secret: SECRET, now: NOW, user: { id: USER_ID } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /event_id/);
  });

  it('event_id 是空字串 → 400', async () => {
    const r = await handleBlockFeedback({ body: { event_id: '' }, query: makeQuery(), secret: SECRET, now: NOW, user: { id: USER_ID } });
    assert.equal(r.status, 400);
  });

  it('event_id 是非字串 → 400', async () => {
    const r = await handleBlockFeedback({ body: { event_id: 123 }, query: makeQuery(), secret: SECRET, now: NOW, user: { id: USER_ID } });
    assert.equal(r.status, 400);
  });
});

describe('handleBlockFeedback - CLI path (Bearer)', () => {
  it('合法 Bearer + event_id 存在 → 200 + 寫 INSERT', async () => {
    const insertCalls = [];
    const r = await handleBlockFeedback({
      body: { event_id: EVENT_ID, reason: '這句沒問題' },
      query: makeQuery({ insertCalls }),
      secret: SECRET, now: NOW,
      user: { id: USER_ID },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(insertCalls.length, 1);
    // 確認寫的 details 含 original_event_id 跟 source=cli
    const detailsParam = insertCalls[0].params[5];
    assert.equal(detailsParam.original_event_id, EVENT_ID);
    assert.equal(detailsParam.source, 'cli');
    assert.equal(detailsParam.reason, '這句沒問題');
  });

  it('reason 超 500 字 → 截斷', async () => {
    const insertCalls = [];
    const longReason = 'A'.repeat(800);
    await handleBlockFeedback({
      body: { event_id: EVENT_ID, reason: longReason },
      query: makeQuery({ insertCalls }),
      secret: SECRET, now: NOW,
      user: { id: USER_ID },
    });
    assert.equal(insertCalls[0].params[5].reason.length, 500);
  });

  it('reason 不傳 → details 不含 reason 欄位', async () => {
    const insertCalls = [];
    await handleBlockFeedback({
      body: { event_id: EVENT_ID },
      query: makeQuery({ insertCalls }),
      secret: SECRET, now: NOW,
      user: { id: USER_ID },
    });
    assert.equal('reason' in insertCalls[0].params[5], false);
  });
});

describe('handleBlockFeedback - Web path (sig)', () => {
  it('合法 sig + user_id → 200 + source=web', async () => {
    const sig = signFeedback(EVENT_ID, USER_ID, TODAY, SECRET);
    const insertCalls = [];
    const r = await handleBlockFeedback({
      body: { event_id: EVENT_ID, sig, user_id: USER_ID },
      query: makeQuery({ insertCalls }),
      secret: SECRET, now: NOW,
      user: null,
    });
    assert.equal(r.status, 200);
    assert.equal(insertCalls[0].params[5].source, 'web');
  });

  it('過期 sig（昨天簽）→ 410 Gone', async () => {
    const sig = signFeedback(EVENT_ID, USER_ID, TODAY - 1, SECRET);
    const r = await handleBlockFeedback({
      body: { event_id: EVENT_ID, sig, user_id: USER_ID },
      query: makeQuery(),
      secret: SECRET, now: NOW,
      user: null,
    });
    assert.equal(r.status, 410);
    assert.match(r.body.error, /expired/);
  });

  it('簽名錯誤 → 401', async () => {
    const r = await handleBlockFeedback({
      body: { event_id: EVENT_ID, sig: '0000000000000000', user_id: USER_ID },
      query: makeQuery(),
      secret: SECRET, now: NOW,
      user: null,
    });
    assert.equal(r.status, 401);
  });

  it('Web path 缺 user_id → 400', async () => {
    const sig = signFeedback(EVENT_ID, USER_ID, TODAY, SECRET);
    const r = await handleBlockFeedback({
      body: { event_id: EVENT_ID, sig },
      query: makeQuery(),
      secret: SECRET, now: NOW,
      user: null,
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /user_id/);
  });

  it('Web path user_id 不是整數 → 400', async () => {
    const sig = signFeedback(EVENT_ID, USER_ID, TODAY, SECRET);
    const r = await handleBlockFeedback({
      body: { event_id: EVENT_ID, sig, user_id: 'abc' },
      query: makeQuery(),
      secret: SECRET, now: NOW,
      user: null,
    });
    assert.equal(r.status, 400);
  });

  it('Web path user_id 跟 sig 簽的不同 → 401（sig 對不上）', async () => {
    const sig = signFeedback(EVENT_ID, USER_ID, TODAY, SECRET);
    const r = await handleBlockFeedback({
      body: { event_id: EVENT_ID, sig, user_id: 999 },
      query: makeQuery(),
      secret: SECRET, now: NOW,
      user: null,
    });
    assert.equal(r.status, 401);
  });
});

describe('handleBlockFeedback - 沒授權', () => {
  it('沒 user 沒 sig → 401', async () => {
    const r = await handleBlockFeedback({
      body: { event_id: EVENT_ID },
      query: makeQuery(),
      secret: SECRET, now: NOW,
      user: null,
    });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /no auth/);
  });
});

describe('handleBlockFeedback - event 不存在 / dedup', () => {
  it('event_id 不存在於 activity_logs → 404', async () => {
    const r = await handleBlockFeedback({
      body: { event_id: EVENT_ID },
      query: makeQuery({ eventExists: false }),
      secret: SECRET, now: NOW,
      user: { id: USER_ID },
    });
    assert.equal(r.status, 404);
  });

  it('5 分鐘內已回報過同 event → 409', async () => {
    const r = await handleBlockFeedback({
      body: { event_id: EVENT_ID },
      query: makeQuery({ dupExists: true }),
      secret: SECRET, now: NOW,
      user: { id: USER_ID },
    });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /already/);
  });
});
