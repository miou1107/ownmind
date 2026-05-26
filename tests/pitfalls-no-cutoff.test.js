import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.93 — Revert the v1.17.92 V17_87_SHIPPED cutoff (transparency fix).
 *
 * Background: v1.17.92 used a cutoff to filter out 8 "historical leftovers from before
 *   v1.17.87 shipped" so pitfalls reported zero. Vin pushed back with "so we just don't
 *   handle them?" — pointing out that the cutoff was a workaround that hid the problem
 *   instead of fixing it, violating both transparency and IR-027 (a reminder is not
 *   enforcement; only logic enforces).
 *
 * Fix: revert the cutoff, let the 8 entries show up for admin. Rewrite fix_hint to say:
 *   - these are historical leftovers from before v1.17.87.
 *   - we cannot backfill (fabricating audit logs would corrupt the audit trail).
 *   - they age out naturally after the 14-day retention.
 *   - not a current bug; no action needed.
 *
 * This commit reverts v1.17.92 — kept as a lesson that workarounds should not exist.
 */

describe('v1.17.93 — sensitive CTE must not carry a V17_87_SHIPPED cutoff', () => {
  const meSource = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');

  it('unobserved sensitive CTE must not filter ts >= 2026-05-11', () => {
    const m = meSource.match(/Section 1: unobserved[\s\S]+?ORDER BY s\.ts DESC/);
    assert.ok(m, 'unobserved query not found');
    assert.doesNotMatch(m[0], /a\.ts\s*>=\s*['"`]?2026-05-11|V17_87_SHIPPED/,
      'unobserved must not apply the V17_87_SHIPPED cutoff (revert the v1.17.92 workaround)');
  });

  it('unverified sensitive CTE must not filter ts >= 2026-05-11 either', () => {
    const m = meSource.match(/Section 2: unverified[\s\S]+?ORDER BY s\.ts DESC/);
    assert.ok(m, 'unverified query not found');
    assert.doesNotMatch(m[0], /a\.ts\s*>=\s*['"`]?2026-05-11|V17_87_SHIPPED/,
      'unverified must not apply the V17_87_SHIPPED cutoff');
  });
});

describe('v1.17.93 — rewrite fmtUnobs / fmtUnverif fix_hint to explain historical leftovers', () => {
  const meSource = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');

  it('fmtUnobs fix_hint should mention the v1.17.87 fix + 14-day retention', () => {
    const m = meSource.match(/const fmtUnobs\s*=[\s\S]+?\};/);
    assert.ok(m, 'fmtUnobs not found');
    assert.match(m[0], /v1\.17\.87/,
      'fix_hint should mention the v1.17.87 milestone');
    assert.match(m[0], /14\s*天|retention/,
      'fix_hint should mention the 14-day retention');
  });

  it('fmtUnobs fix_hint should clearly say "cannot backfill" so admin does not attempt manual backfill', () => {
    const m = meSource.match(/const fmtUnobs\s*=[\s\S]+?\};/);
    assert.ok(m, 'fmtUnobs not found');
    assert.match(m[0], /無法補|不需處理|歷史殘留|歷史資料/,
      'fix_hint must clearly tell admin "this is a past gap, no action needed now"');
  });
});
