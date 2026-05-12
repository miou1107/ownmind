import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { enrichActivityDetails } from '../src/utils/enrich-activity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.89 — 修「停用鐵律「(找不到)」」觀測黑洞
 *
 * 背景（v1.17.88 pitfalls 頁顯示 30 筆漏觀測幾乎都是「停用鐵律「(找不到)」」）：
 *   - client MCP 在 ownmind_disable 時呼叫 logEvent('memory_disable', { id, reason })
 *     送到 server，server 寫入 activity_logs.details 只有 { id, reason }
 *   - 之後 admin 看 /api/me/pitfalls，me.js 靠 subquery JOIN memories 表去補 title/code
 *   - 失敗情境：id 非數字（regex `^\d+$` 不過）、記憶被刪、或 user 對不上時
 *     subquery 回 null，顯示 `(找不到)`，admin 無法回溯停用了哪條
 *
 * 修法：server 端 activity batch 進來時，若是 memory_disable/memory_update
 *   且 target 是 iron_rule，立刻 lookup memories 把 code+title snapshot
 *   寫進 event.details，未來看 activity_log 不需 JOIN 就有完整資訊
 *
 * 兼容歷史資料：me.js pitfalls SQL 改為「優先讀 details snapshot、找不到再 JOIN」
 */

describe('enrichActivityDetails — disable/update 事件 snapshot title+code', () => {
  // 模擬 DB lookup：傳入 id、回傳 memories 對應 row（或 null）
  const makeLookup = (rows) => async (id) => rows[id] || null;

  it('memory_disable + iron_rule：補上 disabled_code + disabled_title', async () => {
    const lookup = makeLookup({
      42: { type: 'iron_rule', code: 'IR-099', title: '測試鐵律' },
    });
    const event = { event: 'memory_disable', details: { id: 42, reason: '不需要了' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.disabled_code, 'IR-099');
    assert.equal(enriched.disabled_title, '測試鐵律');
    // 原本欄位保留
    assert.equal(enriched.id, 42);
    assert.equal(enriched.reason, '不需要了');
  });

  it('memory_disable + 非 iron_rule：不 snapshot（preference 等不算敏感）', async () => {
    const lookup = makeLookup({
      55: { type: 'preference', code: null, title: '我的偏好' },
    });
    const event = { event: 'memory_disable', details: { id: 55, reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.disabled_code, undefined);
    assert.equal(enriched.disabled_title, undefined);
  });

  it('memory_disable + id 非數字：lookup 跳過、不爆炸', async () => {
    const lookup = makeLookup({});
    const event = { event: 'memory_disable', details: { id: 'IR-099', reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    // 仍保留原 details、不報錯
    assert.equal(enriched.id, 'IR-099');
    assert.equal(enriched.disabled_code, undefined);
  });

  it('memory_disable + memory 已被刪（lookup 回 null）：不爆炸、details 原樣', async () => {
    const lookup = makeLookup({});
    const event = { event: 'memory_disable', details: { id: 999, reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.id, 999);
    assert.equal(enriched.disabled_title, undefined);
  });

  it('memory_update + iron_rule：也補 disabled_code/disabled_title（更新後可追溯）', async () => {
    const lookup = makeLookup({
      7: { type: 'iron_rule', code: 'IR-007', title: 'Persistent Bug Protocol' },
    });
    const event = { event: 'memory_update', details: { id: 7 } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.disabled_code, 'IR-007');
    assert.equal(enriched.disabled_title, 'Persistent Bug Protocol');
  });

  it('非 disable/update 事件（例如 memory_save）：不動 details', async () => {
    const lookup = makeLookup({
      1: { type: 'iron_rule', code: 'IR-001', title: 'x' },
    });
    const event = { event: 'memory_save', details: { id: 1, title: '已經有 title 了' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.disabled_code, undefined);
    assert.equal(enriched.title, '已經有 title 了');  // 原樣
  });

  it('event.details 缺 id：直接回傳原 details、不爆炸', async () => {
    const lookup = makeLookup({});
    const event = { event: 'memory_disable', details: { reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.deepEqual(enriched, { reason: 'x' });
  });

  it('event.details 是 null：回傳 {}、不爆炸', async () => {
    const lookup = makeLookup({});
    const event = { event: 'memory_disable', details: null };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.deepEqual(enriched, {});
  });

  it('lookup 函數丟錯：吞掉、回傳原 details（不能讓 enrich 阻擋主 INSERT）', async () => {
    const lookup = async () => { throw new Error('db down'); };
    const event = { event: 'memory_disable', details: { id: 42, reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.id, 42);
    assert.equal(enriched.disabled_title, undefined);
  });
});

describe('activity.js batch handler 整合 — 落 DB 前 enrich', () => {
  const activitySource = fs.readFileSync(path.join(repoRoot, 'src/routes/activity.js'), 'utf8');

  it('activity.js 有 import enrichActivityDetails', () => {
    assert.match(activitySource, /import\s*\{\s*enrichActivityDetails\s*\}\s*from\s*['"]\.\.\/utils\/enrich-activity\.js['"]/,
      'activity.js 應該 import enrichActivityDetails');
  });

  it('batch handler 在 INSERT 前呼叫 enrichActivityDetails', () => {
    // 抓 INSERT 之前的程式碼區塊
    const m = activitySource.match(/router\.post\('\/batch'[\s\S]+?INSERT INTO activity_logs/);
    assert.ok(m, '找不到 batch handler INSERT');
    assert.match(m[0], /enrichActivityDetails/, 'batch handler 應該在 INSERT 之前 enrich details');
  });
});

describe('memory.js disable route — 也要 enrich activity log（直接走 server route 的路徑）', () => {
  // disable route 自己 INSERT iron_rule_compliance，但 activity_logs 的 memory_disable
  // 還是 client logEvent 寫的。修這個黑洞最簡單的修法是 server batch handler enrich，
  // disable route 不用動 — 因為 client 之後會 batch 上傳。
  // 但為了 race condition 安全（client 還沒上傳前 admin 就查 pitfalls），
  // disable route 也應該主動寫一筆 memory_disable activity log（帶完整 snapshot）。
  // 這條測試先 skip — 留待 v1.17.90 評估
});

describe('me.js pitfalls SQL — 優先讀 details snapshot、找不到再 JOIN', () => {
  const meSource = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');

  it('unobserved 查詢的 disabled_title 用 COALESCE(details snapshot, JOIN memories)', () => {
    // 找 unobservedQ 查詢區塊
    const m = meSource.match(/Section 1: unobserved[\s\S]+?ORDER BY s\.ts DESC/);
    assert.ok(m, '找不到 unobserved query');
    // 應該 COALESCE details->>'disabled_title' 跟 JOIN
    assert.match(m[0], /COALESCE\s*\(\s*s\.details->>'disabled_title'/,
      'unobserved query 應優先讀 details->>disabled_title');
    assert.match(m[0], /COALESCE\s*\(\s*s\.details->>'disabled_code'/,
      'unobserved query 應優先讀 details->>disabled_code');
  });

  it('unverified 查詢也同樣優先讀 details snapshot', () => {
    const m = meSource.match(/Section 2: unverified[\s\S]+?ORDER BY s\.ts DESC/);
    assert.ok(m, '找不到 unverified query');
    assert.match(m[0], /COALESCE\s*\(\s*s\.details->>'disabled_title'/,
      'unverified query 應優先讀 details->>disabled_title');
  });
});
