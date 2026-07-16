import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.26.30 — bug-report status_reason enum validation
 *
 * PATCH /api/bug-reports/:id/status needs a live DB, so this follows the
 * source-level verification precedent (memory-title-update.test.js): read the
 * route file and assert the guard wiring exists. Without it, an out-of-enum
 * status_reason trips the DB CHECK constraint and returns a bare 500 instead
 * of an actionable 400 — the exact friction Vin hit closing bug report #5.
 *
 * The allowed set is pinned here so a drift from the DB constraint
 * (db/017_bug_reports_id_to_serial.sql) fails the test.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'bug-reports.js'), 'utf8');
const DB_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'db', '017_bug_reports_id_to_serial.sql'), 'utf8');

// Slice out the PATCH /:id/status handler so assertions can't match elsewhere.
const patchStart = ROUTE_SOURCE.indexOf("router.patch('/:id/status'");
assert.ok(patchStart > 0, 'PATCH /:id/status handler not found');
const patchEnd = ROUTE_SOURCE.indexOf('\nrouter.', patchStart + 10);
const PATCH_BLOCK = ROUTE_SOURCE.slice(
  patchStart, patchEnd > 0 ? patchEnd : ROUTE_SOURCE.length);

// Pull the quoted values out of a chunk of source (e.g. the code constant or
// the SQL IN (...) list), normalized to a sorted array for set comparison.
function quotedValues(chunk) {
  return [...chunk.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

describe('v1.26.30 — PATCH status_reason enum guard', () => {
  it('code constant is the exact same set as the DB CHECK constraint (drift alarm)', () => {
    // Single source of truth: the ALLOWED_STATUS_REASONS constant must equal the
    // bug_reports_status_reason_check enum in db/017 exactly — not a subset. A
    // value added/removed on either side (which would resurrect the 500 or wrongly
    // reject a DB-valid value) must fail this test.
    const constMatch = ROUTE_SOURCE.match(
      /const ALLOWED_STATUS_REASONS = \[([\s\S]*?)\];/);
    assert.ok(constMatch, 'ALLOWED_STATUS_REASONS constant not found');

    const dbMatch = DB_SOURCE.match(
      /bug_reports_status_reason_check[\s\S]*?status_reason IN \(([\s\S]*?)\)/);
    assert.ok(dbMatch, 'bug_reports_status_reason_check IN (...) list not found in db/017');

    assert.deepEqual(quotedValues(constMatch[1]), quotedValues(dbMatch[1]));
  });

  it('rejects an out-of-enum status_reason with a 400 (not a bare 500)', () => {
    // The guard must test membership and return 400 before the UPDATE.
    assert.match(PATCH_BLOCK, /status_reason must be one of/);
    assert.match(PATCH_BLOCK, /ALLOWED_STATUS_REASONS\.includes\(status_reason\)/);
    assert.match(PATCH_BLOCK, /return\s+res[\s\S]{0,120}?status\(400\)/);
  });

  it('still accepts a null / omitted status_reason (column is nullable)', () => {
    // The guard only fires when status_reason is truthy, so NULL stays valid.
    assert.match(PATCH_BLOCK, /if \(status_reason && !ALLOWED_STATUS_REASONS\.includes/);
  });
});
