import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateConfirmString,
  withReportSuggestion,
  isUserInSpamBlock,
  hasDeclinedRecently,
  countSameFingerprintInLastHour,
  shouldRejectByFingerprintRateLimit,
} from '../src/utils/bug-report-helpers.js';

// ============================================================
// validateConfirmString — 驗 confirm_string="送出"
// ============================================================

test('confirm_string 正確值「送出」通過', () => {
  assert.equal(validateConfirmString('送出').ok, true);
});

test('confirm_string 缺漏 → 不通過、有錯誤訊息', () => {
  const r = validateConfirmString(undefined);
  assert.equal(r.ok, false);
  assert.match(r.error, /送出/);
});

test('confirm_string 為其他字串 → 不通過', () => {
  assert.equal(validateConfirmString('yes').ok, false);
  assert.equal(validateConfirmString('').ok, false);
  assert.equal(validateConfirmString('送出aaa').ok, false);
});

test('confirm_string 非字串型別 → 不通過', () => {
  assert.equal(validateConfirmString(123).ok, false);
  assert.equal(validateConfirmString(null).ok, false);
});

// ============================================================
// withReportSuggestion — 加 suggest_report 旗標到錯誤 body
// ============================================================

test('withReportSuggestion 加旗標到 body', () => {
  const result = withReportSuggestion(
    { error: '寫入失敗' },
    'mem_blocked_secret_keyword'
  );
  assert.equal(result.suggest_report, true);
  assert.equal(result.bug_fingerprint, 'mem_blocked_secret_keyword');
  assert.match(result.report_hint, /回報/);
  // 原欄位保留
  assert.equal(result.error, '寫入失敗');
});

test('withReportSuggestion 對未註冊指紋丟錯（防誤用）', () => {
  assert.throws(
    () => withReportSuggestion({ error: 'x' }, 'not_a_registered_fingerprint'),
    /未註冊|invalid/i
  );
});

test('withReportSuggestion 預設 hint 可被選項覆寫', () => {
  const r = withReportSuggestion({ error: 'x' }, 'mem_blocked_secret_keyword', {
    hint: '客製提示文字',
  });
  assert.equal(r.report_hint, '客製提示文字');
});

// ============================================================
// isUserInSpamBlock — 查使用者是否在 24h 封鎖期
// ============================================================

test('isUserInSpamBlock：DB 查到未過期記錄 → 回 true', async () => {
  const mockQuery = async () => ({
    rows: [{ blocked_until: new Date(Date.now() + 3600 * 1000) }],
  });
  assert.equal(await isUserInSpamBlock(mockQuery, 1), true);
});

test('isUserInSpamBlock：DB 查無記錄 → 回 false', async () => {
  const mockQuery = async () => ({ rows: [] });
  assert.equal(await isUserInSpamBlock(mockQuery, 1), false);
});

// ============================================================
// hasDeclinedRecently — 查使用者過去 24h 是否拒絕過該指紋
// ============================================================

test('hasDeclinedRecently：有 24h 內拒絕紀錄 → 回 true', async () => {
  const mockQuery = async () => ({
    rows: [{ declined_at: new Date(Date.now() - 3600 * 1000) }],
  });
  assert.equal(
    await hasDeclinedRecently(mockQuery, 1, 'mem_blocked_secret_keyword'),
    true
  );
});

test('hasDeclinedRecently：無記錄 → 回 false', async () => {
  const mockQuery = async () => ({ rows: [] });
  assert.equal(
    await hasDeclinedRecently(mockQuery, 1, 'mem_blocked_secret_keyword'),
    false
  );
});

// ============================================================
// countSameFingerprintInLastHour — 計同 user + 同指紋過去 1h 幾筆
// ============================================================

test('countSameFingerprintInLastHour：回 DB 計數', async () => {
  const mockQuery = async () => ({ rows: [{ count: '4' }] });
  const n = await countSameFingerprintInLastHour(mockQuery, 1, 'fp_x');
  assert.equal(n, 4);
});

test('countSameFingerprintInLastHour：無記錄回 0', async () => {
  const mockQuery = async () => ({ rows: [{ count: '0' }] });
  assert.equal(await countSameFingerprintInLastHour(mockQuery, 1, 'fp_x'), 0);
});

// ============================================================
// shouldRejectByFingerprintRateLimit — 第 3 筆同指紋直接 429
// ============================================================

test('shouldRejectByFingerprintRateLimit：1h 內 2 筆 → 不擋（要建第 3 筆）', async () => {
  const mockQuery = async () => ({ rows: [{ count: '2' }] });
  const r = await shouldRejectByFingerprintRateLimit(mockQuery, 1, 'fp_x');
  assert.equal(r.reject, false);
});

test('shouldRejectByFingerprintRateLimit：1h 內已 3 筆 → 擋第 4 筆', async () => {
  const mockQuery = async () => ({ rows: [{ count: '3' }] });
  const r = await shouldRejectByFingerprintRateLimit(mockQuery, 1, 'fp_x');
  assert.equal(r.reject, true);
  assert.match(r.message, /同類|429|頻繁/);
});

test('shouldRejectByFingerprintRateLimit：1h 內 10 筆（已超）→ 仍擋', async () => {
  const mockQuery = async () => ({ rows: [{ count: '10' }] });
  const r = await shouldRejectByFingerprintRateLimit(mockQuery, 1, 'fp_x');
  assert.equal(r.reject, true);
});
