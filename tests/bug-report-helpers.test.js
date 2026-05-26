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
// validateConfirmString — verify confirm_string="送出"
// ============================================================

test('confirm_string with the correct value "送出" passes', () => {
  assert.equal(validateConfirmString('送出').ok, true);
});

test('confirm_string missing → fails with an error message', () => {
  const r = validateConfirmString(undefined);
  assert.equal(r.ok, false);
  assert.match(r.error, /送出/);
});

test('confirm_string with any other string → fails', () => {
  assert.equal(validateConfirmString('yes').ok, false);
  assert.equal(validateConfirmString('').ok, false);
  assert.equal(validateConfirmString('送出aaa').ok, false);
});

test('confirm_string with a non-string type → fails', () => {
  assert.equal(validateConfirmString(123).ok, false);
  assert.equal(validateConfirmString(null).ok, false);
});

// ============================================================
// withReportSuggestion — adds the suggest_report flag to an error body
// ============================================================

test('withReportSuggestion adds the flag to the body', () => {
  const result = withReportSuggestion(
    { error: '寫入失敗' },
    'mem_blocked_secret_keyword'
  );
  assert.equal(result.suggest_report, true);
  assert.equal(result.bug_fingerprint, 'mem_blocked_secret_keyword');
  assert.match(result.report_hint, /回報/);
  // Original field preserved
  assert.equal(result.error, '寫入失敗');
});

test('withReportSuggestion throws on an unregistered fingerprint (defensive)', () => {
  assert.throws(
    () => withReportSuggestion({ error: 'x' }, 'not_a_registered_fingerprint'),
    /未註冊|invalid/i
  );
});

test('withReportSuggestion default hint can be overridden by an option', () => {
  const r = withReportSuggestion({ error: 'x' }, 'mem_blocked_secret_keyword', {
    hint: '客製提示文字',
  });
  assert.equal(r.report_hint, '客製提示文字');
});

// v1.26.1: free-form escape hatch fingerprint usable by withReportSuggestion.
test('v1.26.1: withReportSuggestion accepts clt_user_reported_other', () => {
  const r = withReportSuggestion({ error: 'x' }, 'clt_user_reported_other');
  assert.equal(r.suggest_report, true);
  assert.equal(r.bug_fingerprint, 'clt_user_reported_other');
});

// ============================================================
// isUserInSpamBlock — check whether a user is in the 24h block window
// ============================================================

test('isUserInSpamBlock: DB returns an un-expired record → true', async () => {
  const mockQuery = async () => ({
    rows: [{ blocked_until: new Date(Date.now() + 3600 * 1000) }],
  });
  assert.equal(await isUserInSpamBlock(mockQuery, 1), true);
});

test('isUserInSpamBlock: DB has no record → false', async () => {
  const mockQuery = async () => ({ rows: [] });
  assert.equal(await isUserInSpamBlock(mockQuery, 1), false);
});

// ============================================================
// hasDeclinedRecently — has the user declined this fingerprint in the last 24h?
// ============================================================

test('hasDeclinedRecently: decline record within 24h → true', async () => {
  const mockQuery = async () => ({
    rows: [{ declined_at: new Date(Date.now() - 3600 * 1000) }],
  });
  assert.equal(
    await hasDeclinedRecently(mockQuery, 1, 'mem_blocked_secret_keyword'),
    true
  );
});

test('hasDeclinedRecently: no record → false', async () => {
  const mockQuery = async () => ({ rows: [] });
  assert.equal(
    await hasDeclinedRecently(mockQuery, 1, 'mem_blocked_secret_keyword'),
    false
  );
});

// ============================================================
// countSameFingerprintInLastHour — count same user + same fingerprint in the last 1h
// ============================================================

test('countSameFingerprintInLastHour: returns DB count', async () => {
  const mockQuery = async () => ({ rows: [{ count: '4' }] });
  const n = await countSameFingerprintInLastHour(mockQuery, 1, 'fp_x');
  assert.equal(n, 4);
});

test('countSameFingerprintInLastHour: no records returns 0', async () => {
  const mockQuery = async () => ({ rows: [{ count: '0' }] });
  assert.equal(await countSameFingerprintInLastHour(mockQuery, 1, 'fp_x'), 0);
});

// ============================================================
// shouldRejectByFingerprintRateLimit — return 429 on the 3rd same-fingerprint hit
// ============================================================

test('shouldRejectByFingerprintRateLimit: 2 in 1h → not blocked (allow the 3rd)', async () => {
  const mockQuery = async () => ({ rows: [{ count: '2' }] });
  const r = await shouldRejectByFingerprintRateLimit(mockQuery, 1, 'fp_x');
  assert.equal(r.reject, false);
});

test('shouldRejectByFingerprintRateLimit: already 3 in 1h → block the 4th', async () => {
  const mockQuery = async () => ({ rows: [{ count: '3' }] });
  const r = await shouldRejectByFingerprintRateLimit(mockQuery, 1, 'fp_x');
  assert.equal(r.reject, true);
  assert.match(r.message, /同類|429|頻繁/);
});

test('shouldRejectByFingerprintRateLimit: 10 in 1h (over limit) → still blocks', async () => {
  const mockQuery = async () => ({ rows: [{ count: '10' }] });
  const r = await shouldRejectByFingerprintRateLimit(mockQuery, 1, 'fp_x');
  assert.equal(r.reject, true);
});
