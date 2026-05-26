/**
 * Reproduction test: root cause for iron_rule_compliance events dropping to 0 after 4/21.
 *
 * Background (diagnosed 2026-05-07):
 *   - MCP tool ownmind_report_compliance write path was healthy.
 *   - But SessionStart hook fetched the init API with ?compact=true.
 *   - compact strips the entire INSTRUCTIONS_SOP (src/routes/memory.js:653)
 *     → the AI never sees the "must call ownmind_report_compliance" instruction in the compact response.
 *   - Over time the AI stopped invoking it; after 4/21 it stopped completely.
 *
 * Fix: always append the compliance instruction at the tail of iron_rules_digest so it
 * survives compact mode. The digest is a natural pair for compliance reporting (iron rule
 * triggers → compliance report), so the semantics stay consistent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const memorySource = readFileSync(join(__dirname, '..', 'src', 'routes', 'memory.js'), 'utf8');

test('init route: iron_rules_digest must contain the ownmind_report_compliance instruction (delivered in compact too)', () => {
  // Before the fix: compliance instruction lived only in INSTRUCTIONS_SOP and was filtered out by !compact.
  // After the fix: the instruction is always appended at the tail of the digest.
  assert.match(
    memorySource,
    /ironRulesDigestFinal[\s\S]*?ownmind_report_compliance/,
    'src/routes/memory.js must add a "call ownmind_report_compliance" line when assembling ironRulesDigestFinal, otherwise compact mode loses the instruction'
  );
});

test('init route: compact mode still emits iron_rules_digest (must not be filtered)', () => {
  // Confirm the digest reaches res.json regardless of compact.
  // This should pass both before and after the fix — it's a control test, guarding against
  // future refactors moving the digest behind a compact guard.
  assert.match(
    memorySource,
    /iron_rules_digest:\s*ironRulesDigestFinal/,
    'res.json must emit iron_rules_digest directly (no !compact guard allowed)'
  );
});

test('init route: compliance instruction must mention all three actions — comply / skip / violate', () => {
  // Make sure the instruction is complete so the AI does not remember only comply and forget skip / violate.
  const digestSection = memorySource.match(
    /ironRulesDigestFinal[\s\S]{0,1500}/
  )?.[0] || '';
  for (const action of ['comply', 'skip', 'violate']) {
    assert.ok(
      digestSection.includes(action),
      `tail of digest must mention action='${action}'; the captured section does not contain this keyword`
    );
  }
});
