import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  deriveSecret,
  dayBucket,
  signFeedback,
  verifyFeedback,
} = await import('../src/utils/feedback-sig.js');

const TEST_KEY = 'test-encryption-key-32-bytes-fixed';

describe('deriveSecret', () => {
  it('同 input 同 output（deterministic）', () => {
    const a = deriveSecret(TEST_KEY);
    const b = deriveSecret(TEST_KEY);
    assert.equal(a, b);
  });

  it('不同 ENCRYPTION_KEY 不同 secret', () => {
    const a = deriveSecret('key-a');
    const b = deriveSecret('key-b');
    assert.notEqual(a, b);
  });

  it('回傳 hex 字串、64 字元（256 bit）', () => {
    const s = deriveSecret(TEST_KEY);
    assert.match(s, /^[0-9a-f]{64}$/);
  });
});

describe('dayBucket', () => {
  it('同一天回傳相同 bucket', () => {
    const noon = new Date('2026-05-14T12:00:00Z').getTime();
    const evening = new Date('2026-05-14T22:30:00Z').getTime();
    assert.equal(dayBucket(noon), dayBucket(evening));
  });

  it('不同天回傳不同 bucket', () => {
    const day1 = new Date('2026-05-14T23:59:59Z').getTime();
    const day2 = new Date('2026-05-15T00:00:01Z').getTime();
    assert.notEqual(dayBucket(day1), dayBucket(day2));
  });

  it('bucket 是整數', () => {
    const t = new Date('2026-05-14T12:00:00Z').getTime();
    assert.equal(Number.isInteger(dayBucket(t)), true);
  });
});

describe('signFeedback', () => {
  const secret = deriveSecret(TEST_KEY);
  const day = dayBucket(new Date('2026-05-14T12:00:00Z').getTime());

  it('回傳 16 字元 hex', () => {
    const sig = signFeedback('evt_abc', 1, day, secret);
    assert.match(sig, /^[0-9a-f]{16}$/);
  });

  it('同 input 同 output', () => {
    const a = signFeedback('evt_abc', 1, day, secret);
    const b = signFeedback('evt_abc', 1, day, secret);
    assert.equal(a, b);
  });

  it('不同 event_id 不同 sig', () => {
    const a = signFeedback('evt_abc', 1, day, secret);
    const b = signFeedback('evt_xyz', 1, day, secret);
    assert.notEqual(a, b);
  });

  it('不同 user_id 不同 sig', () => {
    const a = signFeedback('evt_abc', 1, day, secret);
    const b = signFeedback('evt_abc', 2, day, secret);
    assert.notEqual(a, b);
  });

  it('不同 day_bucket 不同 sig', () => {
    const a = signFeedback('evt_abc', 1, day, secret);
    const b = signFeedback('evt_abc', 1, day + 1, secret);
    assert.notEqual(a, b);
  });
});

describe('verifyFeedback', () => {
  const secret = deriveSecret(TEST_KEY);
  const now = new Date('2026-05-14T12:00:00Z').getTime();
  const today = dayBucket(now);

  it('合法 sig 過（同一天簽、同一天驗）', () => {
    const sig = signFeedback('evt_abc', 1, today, secret);
    const r = verifyFeedback('evt_abc', 1, sig, secret, now);
    assert.equal(r.ok, true);
  });

  it('簽名錯誤 → ok:false reason:invalid_sig', () => {
    const r = verifyFeedback('evt_abc', 1, '0000000000000000', secret, now);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_sig');
  });

  it('event_id 被篡改 → ok:false reason:invalid_sig', () => {
    const sig = signFeedback('evt_abc', 1, today, secret);
    const r = verifyFeedback('evt_xyz', 1, sig, secret, now);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_sig');
  });

  it('user_id 被篡改 → ok:false reason:invalid_sig', () => {
    const sig = signFeedback('evt_abc', 1, today, secret);
    const r = verifyFeedback('evt_abc', 2, sig, secret, now);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_sig');
  });

  it('過期 sig（24h 前簽、現在驗）→ ok:false reason:expired', () => {
    const yesterday = today - 1;
    const sig = signFeedback('evt_abc', 1, yesterday, secret);
    const r = verifyFeedback('evt_abc', 1, sig, secret, now);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'expired');
  });

  it('未來 sig（明天簽、現在驗）→ ok:false reason:invalid_sig', () => {
    // 防 server 時鐘漂移攻擊：未來 sig 不接受
    const tomorrow = today + 1;
    const sig = signFeedback('evt_abc', 1, tomorrow, secret);
    const r = verifyFeedback('evt_abc', 1, sig, secret, now);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_sig');
  });

  it('sig 長度錯誤 → ok:false reason:invalid_sig', () => {
    const r = verifyFeedback('evt_abc', 1, 'abc', secret, now);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_sig');
  });

  it('sig 非 hex → ok:false reason:invalid_sig', () => {
    const r = verifyFeedback('evt_abc', 1, 'zzzzzzzzzzzzzzzz', secret, now);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_sig');
  });

  it('sig 是 null/undefined → ok:false reason:invalid_sig', () => {
    assert.equal(verifyFeedback('evt_abc', 1, null, secret, now).ok, false);
    assert.equal(verifyFeedback('evt_abc', 1, undefined, secret, now).ok, false);
  });
});

describe('verifyFeedback timing safety', () => {
  it('比較用 timingSafeEqual、長度不同也不會 throw', () => {
    const secret = deriveSecret(TEST_KEY);
    const now = Date.now();
    // 不同長度的 sig 不會拋 RangeError、回 invalid_sig
    assert.doesNotThrow(() => verifyFeedback('evt', 1, '12', secret, now));
    assert.doesNotThrow(() => verifyFeedback('evt', 1, 'a'.repeat(100), secret, now));
  });
});
