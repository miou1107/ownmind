import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { buildSessionRecentQuery } = await import('../src/lib/session-query.js');

/**
 * v1.17.13 — GET /api/session/recent 加 `q` 參數（回報者 Michelle）
 *
 * Michelle 用 `ownmind_search` 搜 "ai_kol" / "Selenium" / "趨勢" 全部回空。
 * Root cause：search endpoint 只查 memories 表，但 session_logs（由
 * ownmind_log_session 寫入）是獨立表，永遠 miss。
 *
 * 修法：在 /api/session/recent 加 q query，可 ILIKE search summary+details。
 * MCP 端 ownmind_search 再同時呼叫兩個 endpoint 合併結果。
 */

describe('buildSessionRecentQuery — 純函式', () => {
  it('無 q — 照舊行為：user_id + days 過濾', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 7 });
    assert.match(q.text, /WHERE user_id = \$1/);
    assert.match(q.text, /created_at >= NOW\(\) - INTERVAL '1 day' \* \$2/);
    assert.doesNotMatch(q.text, /ILIKE/);
    assert.deepEqual(q.values, [6, 7]);
  });

  it('has q — 加 ILIKE 過濾 summary + details', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 30, q: 'ai_kol' });
    assert.match(q.text, /ILIKE/);
    // summary 或 details::text 要 match（details 是 JSONB 需 cast）
    assert.match(q.text, /summary\s+ILIKE/);
    assert.match(q.text, /details::text[\s\S]{0,20}ILIKE/);
    // q 以 %...% pattern 傳進 values
    const qIdx = q.values.findIndex((v) => typeof v === 'string' && v.startsWith('%') && v.endsWith('%'));
    assert.ok(qIdx >= 0, `expected pattern, got: ${JSON.stringify(q.values)}`);
    assert.equal(q.values[qIdx], '%ai_kol%');
  });

  it('has tool filter — AND tool = $N', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 7, tool: 'cursor' });
    assert.match(q.text, /AND tool = \$\d+/);
    assert.ok(q.values.includes('cursor'));
  });

  it('includeCompressed=false 時過濾 compressed', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 7, includeCompressed: false });
    assert.match(q.text, /AND compressed = false/);
  });

  it('includeCompressed=true 時不過濾', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 7, includeCompressed: true });
    assert.doesNotMatch(q.text, /compressed\s*=\s*false/);
  });

  it('ORDER BY created_at DESC', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 7 });
    assert.match(q.text, /ORDER BY created_at DESC/);
  });

  it('q + tool 組合', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 7, q: 'Spec', tool: 'cursor' });
    assert.match(q.text, /ILIKE/);
    assert.match(q.text, /AND tool = \$\d+/);
    assert.ok(q.values.includes('%Spec%'));
    assert.ok(q.values.includes('cursor'));
  });

  it('q 被 wrap 成 %q% pattern，不 unwrap original', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 7, q: '50%' });
    // % 在 ILIKE 是 wildcard，使用者輸入的 % 照樣 pass（已記入 ILIKE spec）
    assert.ok(q.values.includes('%50%%'));
  });

  it('空 q 當沒 q', () => {
    const q = buildSessionRecentQuery({ userId: 6, days: 7, q: '' });
    assert.doesNotMatch(q.text, /ILIKE/);
  });
});
