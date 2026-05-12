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

  it('memory_disable + 非 iron_rule：snapshot disabled_type（給 pitfalls filter 用）但不 snapshot code/title', async () => {
    // v1.17.90: 改寫 v1.17.89 行為
    // 任何 memory type 的 disable 都要 snapshot disabled_type，否則 pitfalls SQL
    // 無法把 team_standard / project disable 從 sensitive 列表 filter 掉
    // （v1.17.88 30 筆漏觀測有 22 筆其實是 team_standard / project / standard_detail
    // 被誤算進 iron_rule sensitive event）
    const lookup = makeLookup({
      55: { type: 'preference', code: null, title: '我的偏好' },
    });
    const event = { event: 'memory_disable', details: { id: 55, reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.disabled_type, 'preference', '應 snapshot type 給 pitfalls SQL filter');
    assert.equal(enriched.disabled_code, undefined, '非 iron_rule 不應 snapshot code');
    assert.equal(enriched.disabled_title, undefined, '非 iron_rule 不應 snapshot title');
  });

  it('memory_disable + team_standard：snapshot disabled_type=team_standard（這是 v1.17.90 修法主場景）', async () => {
    const lookup = makeLookup({
      199: { type: 'team_standard', code: null, title: 'gitlab-migration-standard' },
    });
    const event = { event: 'memory_disable', details: { id: 199, reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.disabled_type, 'team_standard');
    assert.equal(enriched.disabled_code, undefined);
  });

  it('memory_disable + iron_rule：也 snapshot disabled_type=iron_rule（給 SQL filter）', async () => {
    // 確認 v1.17.89 既有行為（snapshot code+title）+ v1.17.90 新行為（snapshot type）並存
    const lookup = makeLookup({
      42: { type: 'iron_rule', code: 'IR-099', title: '測試鐵律' },
    });
    const event = { event: 'memory_disable', details: { id: 42, reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.disabled_type, 'iron_rule');
    assert.equal(enriched.disabled_code, 'IR-099');
    assert.equal(enriched.disabled_title, '測試鐵律');
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

describe('v1.17.90 — me.js pitfalls SQL 必須過濾掉非 iron_rule disable', () => {
  // 背景：v1.17.88 pitfalls 顯示 30 筆漏觀測，prod DB 查詢結果：
  //   22 筆是 team_standard / standard_detail / project disable（誤算進 sensitive）
  //   8 筆是 iron_rule save 真的缺 compliance
  //   誤報率 73%
  // 修法：sensitive CTE 的 memory_disable 分支要過濾 type='iron_rule'
  const meSource = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');

  it('unobserved sensitive CTE 的 memory_disable 分支必須過濾 iron_rule', () => {
    const m = meSource.match(/Section 1: unobserved[\s\S]+?ORDER BY s\.ts DESC/);
    assert.ok(m, '找不到 unobserved query');
    // 用 COALESCE 讀 details snapshot、fallback JOIN memories — 任一條件必為 iron_rule
    // 接受兩種寫法：直接 inline COALESCE in WHERE，或在 SELECT 出 mem_type 後 WHERE
    // 注意：用 [\s\S]* 而非 .* 因為 SQL 是多行寫
    assert.match(m[0], /disabled_type[\s\S]*?iron_rule|memory_type[\s\S]*?iron_rule|m\.type[\s\S]*?iron_rule/,
      'unobserved sensitive 列表的 memory_disable 應只算 iron_rule（其他 type 不該觸發 IR-006）');
  });

  it('unverified sensitive CTE 的 memory_disable 分支也必須過濾 iron_rule', () => {
    const m = meSource.match(/Section 2: unverified[\s\S]+?ORDER BY s\.ts DESC/);
    assert.ok(m, '找不到 unverified query');
    assert.match(m[0], /disabled_type[\s\S]*?iron_rule|memory_type[\s\S]*?iron_rule|m\.type[\s\S]*?iron_rule/,
      'unverified sensitive 列表的 memory_disable 應只算 iron_rule');
  });
});

describe('v1.17.90 — enrichActivityDetails 對所有 memory type 都 snapshot disabled_type', () => {
  // 為了讓 me.js pitfalls SQL 不用每筆都 JOIN memories 才能 filter 出 iron_rule
  // disable，enrich 應對所有 type 都寫 disabled_type 到 details
  it('preference、project、team_standard、standard_detail 全部都會被 snapshot disabled_type', async () => {
    const types = ['preference', 'project', 'team_standard', 'standard_detail'];
    for (const t of types) {
      const lookup = async () => ({ type: t, code: null, title: 'x' });
      const event = { event: 'memory_disable', details: { id: 1, reason: 'x' } };
      const enriched = await enrichActivityDetails(event, lookup);
      assert.equal(enriched.disabled_type, t, `type=${t} 應被 snapshot 到 disabled_type`);
      assert.equal(enriched.disabled_code, undefined, `type=${t} 不該 snapshot code`);
    }
  });

  it('防禦邊界：lookup 回 row 但 type 是 null（schema NOT NULL、理論不會發生）', async () => {
    // Reviewer minor #6：若 row 存在但 type 欄位為 null（schema 違反），
    // disabled_type 會寫 null。pitfalls SQL 的 COALESCE(snapshot, JOIN) 看到
    // JSONB null 會 fallback JOIN、依然能 filter 出正確 type。
    const lookup = async () => ({ type: null, code: null, title: null });
    const event = { event: 'memory_disable', details: { id: 1, reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.disabled_type, null, 'type=null 寫成 null（不是 undefined）讓 COALESCE fallback 生效');
    assert.equal(enriched.disabled_code, undefined, '非 iron_rule 不該 snapshot code');
  });
});
