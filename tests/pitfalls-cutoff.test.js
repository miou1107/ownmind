import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.92 — pitfalls unobserved/unverified 加 V17_87_SHIPPED cutoff
 *
 * 背景：v1.17.91 部署完、prod DB pitfalls 還剩 8 筆 iron_rule save 漏觀測。
 *   實際追查：8 筆全部在 2026-05-11 16:29 之前（v1.17.87 commit 4302b09 時間）
 *
 *   v1.17.87 memory.js POST 已加 server-side autoEmit observed_trigger、
 *   v1.17.45 activity.js batch handler 也對 memory_save iron_rule autoEmit。
 *   兩條路徑都會發 compliance log — v1.17.87 ship 後新事件不會再漏。
 *
 *   驗證：prod DB 5/11 16:30 後 0 筆新 iron_rule save、修法已生效。
 *   剩下 8 筆是「v1.17.87 ship 前的歷史殘留」、非系統 bug。
 *
 * 修法：me.js 已有 V17_37_SHIPPED cutoff 給 orphan section（line 865）。
 *   unobserved + unverified section 也該有對應的 V17_87_SHIPPED cutoff、
 *   避免歷史資料汙染現況分析。
 */

describe('v1.17.92 — me.js pitfalls cutoff', () => {
  const meSource = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');

  it('要有 V17_87_SHIPPED = 2026-05-11 常數', () => {
    assert.match(meSource, /V17_87_SHIPPED\s*=\s*['"]2026-05-11/,
      '應該定義 V17_87_SHIPPED cutoff，跟 v1.17.87 commit 時間 (2026-05-11 16:29) 對齊');
  });

  it('unobserved query 用 V17_87_SHIPPED 過濾掉歷史殘留', () => {
    const m = meSource.match(/Section 1: unobserved[\s\S]+?ORDER BY s\.ts DESC/);
    assert.ok(m, '找不到 unobserved query');
    assert.match(m[0], /V17_87_SHIPPED|ts\s*>=\s*['"]2026-05-11/,
      'unobserved query 應該套 V17_87_SHIPPED cutoff（避免 v1.17.87 修法前的歷史殘留干擾現況）');
  });

  it('unverified query 也用 V17_87_SHIPPED 過濾', () => {
    const m = meSource.match(/Section 2: unverified[\s\S]+?ORDER BY s\.ts DESC/);
    assert.ok(m, '找不到 unverified query');
    assert.match(m[0], /V17_87_SHIPPED|ts\s*>=\s*['"]2026-05-11/,
      'unverified query 也該套 V17_87_SHIPPED cutoff');
  });
});
