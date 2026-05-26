import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { evaluateConditions } from '../shared/verification.js';
import { appendCompliance, readComplianceEvents } from '../shared/compliance.js';

/**
 * v1.20.2 follow-up：autoComply 應讀檔案而非僅 in-memory complianceEvents
 *
 * 背景（白話）：
 * - MCP 的 ownmind_report_compliance 在 case handler 內有個「E3: Auto-verify on trigger detection」
 *   段落（mcp/index.js:1090-1129）、會跑一次 IR-025 之類的驗證、若失敗則 block。
 * - 原本它用記憶體變數 `complianceEvents`、session 重啟（白話：MCP 進程重新啟動）就清空。
 * - pre-commit 鉤子改用 readComplianceEvents 從 jsonl 檔案讀、所以鉤子放行 / autoComply 阻擋會不一致。
 * - 修法：autoComply 也從檔案讀、跟鉤子一致。
 *
 * 本測試直接驗證「設計合約」：
 *   GIVEN in-memory 是空陣列（模擬 session 重啟）
 *   AND 檔案有 verification + code-review 兩筆 fresh comply 記錄
 *   WHEN 跑 IR-025 conditions
 *   THEN pass=true、不該 block
 */

const TMP_LOG = path.join(os.tmpdir(), `ownmind-test-compliance-${process.pid}.jsonl`);

const IR025_CONDITIONS = {
  operator: 'AND',
  checks: [
    {
      type: 'recent_event_exists',
      params: { event: 'verification', action: 'comply' },
      message: '還沒做 verification'
    },
    {
      type: 'recent_event_exists',
      params: { event: 'code-review', action: 'comply' },
      message: '還沒做 code review'
    }
  ]
};

describe('v1.20.2 follow-up：autoComply 讀檔案而非僅 in-memory', () => {
  before(() => {
    process.env.__OWNMIND_COMPLIANCE_LOG_PATH = TMP_LOG;
    // 清乾淨、避免上次測試殘留
    if (fs.existsSync(TMP_LOG)) fs.unlinkSync(TMP_LOG);
  });

  after(() => {
    if (fs.existsSync(TMP_LOG)) fs.unlinkSync(TMP_LOG);
    delete process.env.__OWNMIND_COMPLIANCE_LOG_PATH;
  });

  it('in-memory 空、檔案有 verification + code-review → IR-025 pass', () => {
    // 寫兩筆 fresh comply 進檔案、模擬上一個 session 已做品管
    appendCompliance({
      event: 'verification',
      action: 'comply',
      rule_code: '',
      rule_title: 'verification',
      source: 'mcp',
    });
    appendCompliance({
      event: 'code-review',
      action: 'comply',
      rule_code: '',
      rule_title: 'code-review',
      source: 'mcp',
    });

    // 模擬 session 重啟：in-memory 陣列為空、ctx 從檔案讀
    const fileEvents = readComplianceEvents();
    assert.equal(fileEvents.length, 2, '檔案應該讀回 2 筆 fresh comply 記錄');

    // 跑 IR-025 conditions、預期 pass=true
    const ctx = { complianceEvents: fileEvents };
    const result = evaluateConditions(IR025_CONDITIONS, ctx);
    assert.equal(result.pass, true,
      `預期 pass=true、實際 failures: ${JSON.stringify(result.failures)}`);
    assert.deepEqual(result.failures, []);
  });

  it('反證：若只讀 in-memory（空陣列）會錯誤 block — 證明原 bug 真實存在', () => {
    // 即使檔案有兩筆 fresh comply、in-memory 空就會 block
    const inMemoryOnly = []; // 模擬 session 重啟後 in-memory
    const ctx = { complianceEvents: inMemoryOnly };
    const result = evaluateConditions(IR025_CONDITIONS, ctx);
    assert.equal(result.pass, false, '原 bug：只看 in-memory 會錯誤 block');
    assert.equal(result.failures.length, 2);
  });

  it('檔案 + in-memory 合併：兩個來源都有資料時應 pass', () => {
    // 場景（白話）：本 session 內呼叫過 verification（in-memory 有）、檔案累積過 code-review
    const inMemory = [
      { event: 'verification', action: 'comply', ts: new Date().toISOString() }
    ];
    const fileEvents = readComplianceEvents();
    const merged = [...inMemory, ...fileEvents];
    const ctx = { complianceEvents: merged };
    const result = evaluateConditions(IR025_CONDITIONS, ctx);
    assert.equal(result.pass, true, '合併兩來源、預期 pass');
  });
});
