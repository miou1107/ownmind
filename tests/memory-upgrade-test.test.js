import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Lightweight unit test covering only the route guard logic
// (memory.js is a single router file; full DB-backed integration is skipped for now — run E2E at P8 deploy)

describe('memory route: is_test guard logic', () => {
  const src = fs.readFileSync(new URL('../src/routes/memory.js', import.meta.url), 'utf8');

  it('POST / handles the is_test flag correctly (only allows __upgrade_test__ prefix)', () => {
    assert.match(src, /is_test/);
    assert.match(src, /__upgrade_test__/);
    assert.match(src, /upgrade verification.*title must start with __upgrade_test__|is only allowed for upgrade verification/);
  });

  it('test-cleanup route exists and has a prefix guard', () => {
    assert.match(src, /router\.delete\(['"]\/test-cleanup['"]/);
    assert.match(src, /name_prefix must start with __upgrade_test__/);
    assert.match(src, /is_test = TRUE/);
  });

  it('test-cleanup is restricted to the current user (prevents cross-user deletion)', () => {
    // DELETE SQL must include the user_id = $1 filter
    const deleteBlock = src.match(
      /router\.delete\(['"]\/test-cleanup['"][\s\S]*?(?=router\.)/
    )?.[0] || '';
    assert.match(deleteBlock, /WHERE user_id = \$1/);
  });
});
