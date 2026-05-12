import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.93 — Revert v1.17.92 V17_87_SHIPPED cutoff（透明度修正）
 *
 * 背景：v1.17.92 用 cutoff 把 8 筆「v1.17.87 ship 前的歷史殘留」過濾掉、
 *   讓 pitfalls 顯示 0。Vin 質疑「所以不用處理嗎」— 點出 cutoff 是
 *   workaround、把問題藏起來不解決、違反「透明度」原則 + IR-027
 *  （提醒無效、邏輯才有效）。
 *
 * 修法：revert cutoff、留著 8 筆顯示給 admin。改 fix_hint 明確說：
 *   - 這些是 v1.17.87 之前的歷史殘留
 *   - 無法補記（補假 audit log 反而汙染稽核）
 *   - 14 天 retention 後自然消失
 *   - 不是現況 bug、不需要修
 *
 * 這個 commit 反向了 v1.17.92 — 留著當「workaround 不該存在」的教訓。
 */

describe('v1.17.93 — sensitive CTE 不該有 V17_87_SHIPPED cutoff', () => {
  const meSource = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');

  it('unobserved sensitive CTE 不該過濾 ts >= 2026-05-11', () => {
    const m = meSource.match(/Section 1: unobserved[\s\S]+?ORDER BY s\.ts DESC/);
    assert.ok(m, '找不到 unobserved query');
    assert.doesNotMatch(m[0], /a\.ts\s*>=\s*['"`]?2026-05-11|V17_87_SHIPPED/,
      'unobserved 不該套 V17_87_SHIPPED cutoff（v1.17.92 那條 workaround revert）');
  });

  it('unverified sensitive CTE 也不該過濾 ts >= 2026-05-11', () => {
    const m = meSource.match(/Section 2: unverified[\s\S]+?ORDER BY s\.ts DESC/);
    assert.ok(m, '找不到 unverified query');
    assert.doesNotMatch(m[0], /a\.ts\s*>=\s*['"`]?2026-05-11|V17_87_SHIPPED/,
      'unverified 不該套 V17_87_SHIPPED cutoff');
  });
});

describe('v1.17.93 — fmtUnobs / fmtUnverif fix_hint 改寫清楚說明歷史殘留', () => {
  const meSource = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');

  it('fmtUnobs fix_hint 應提到 v1.17.87 修法 + 14 天 retention', () => {
    const m = meSource.match(/const fmtUnobs\s*=[\s\S]+?\};/);
    assert.ok(m, '找不到 fmtUnobs');
    assert.match(m[0], /v1\.17\.87/,
      'fix_hint 要提 v1.17.87 修法時間點');
    assert.match(m[0], /14\s*天|retention/,
      'fix_hint 要提 14 天 retention 自然消失');
  });

  it('fmtUnobs fix_hint 應明確說「無法補記」避免 admin 嘗試人工 backfill', () => {
    const m = meSource.match(/const fmtUnobs\s*=[\s\S]+?\};/);
    assert.ok(m, '找不到 fmtUnobs');
    assert.match(m[0], /無法補|不需處理|歷史殘留|歷史資料/,
      'fix_hint 要明白告訴 admin「這是過去 gap、不需現在處理」');
  });
});
