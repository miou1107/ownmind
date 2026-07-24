import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RULE_FULL_LAYER_SYNC } from '../shared/lint-event-types.js';
import { autoEmitObservedTrigger } from '../src/routes/activity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

// A personal iron-rule code looks like "IR-006". Product code must never
// emit or primarily key compliance data on one.
const PERSONAL_CODE = /^IR-\d+$/;

/**
 * v1.26.32 — the iron-rule compliance observability loop must be de-identified.
 *
 * Before: both the emit side (activity.js / mcp/index.js) and the expect side
 * (me.js) hardcoded one user's personal rule code IR-006. For every other
 * OwnMind user, rule #6 is something else, so the cross-user pitfalls view and
 * the emitted compliance rows were labelled with a rule they do not have.
 *
 * After: the loop keys on the neutral event constant `rule_full_layer_sync`
 * (registered in shared/lint-event-types.js), mirroring the v1.20.4 reply-lint
 * neutralization. me.js keeps IR-006 ONLY as a documented legacy-match shim for
 * historical production rows.
 */
describe('v1.26.32 — de-identify compliance observability', () => {
  it('shared/lint-event-types.js exports the neutral rule_full_layer_sync event', () => {
    assert.equal(RULE_FULL_LAYER_SYNC, 'rule_full_layer_sync');
  });

  it('autoEmitObservedTrigger emits a neutral event, not a personal iron-rule code', async () => {
    const trig = await autoEmitObservedTrigger(1, {
      event: 'memory_save',
      details: { type: 'iron_rule', title: 'whatever' },
    });
    assert.ok(trig, 'expected a trigger for a memory_save iron_rule event');
    assert.equal(trig.triggered_by_event, RULE_FULL_LAYER_SYNC,
      'emit must tag the neutral triggered_by_event');
    assert.doesNotMatch(trig.rule_code || '', PERSONAL_CODE,
      'emit must not carry a personal iron-rule code');
  });

  it('activity.js emit drops the hardcoded personal rule code and title', () => {
    const src = read('src/routes/activity.js');
    const fn = src.slice(
      src.indexOf('autoEmitObservedTrigger(userId, event)'),
      src.indexOf('router.post(')
    );
    assert.doesNotMatch(fn, /rule_code:\s*'IR-\d+'/,
      'activity.js emit must not hardcode rule_code: IR-XXX');
    assert.doesNotMatch(fn, /學到東西必須全層同步更新/,
      'activity.js emit must not carry a specific user\'s verbatim rule title');
    assert.match(fn, /triggered_by_event/,
      'activity.js emit must set triggered_by_event');
  });

  it('memory.js server-side backfill emit is de-identified (both save + disable paths)', () => {
    const src = read('src/routes/memory.js');
    // Isolate the two iron_rule_compliance INSERT detail blocks.
    const emitBlocks = [...src.matchAll(/'iron_rule_compliance'[\s\S]{0,600}?tool_call: 'memory_(?:save|disable)'/g)]
      .map((m) => m[0]);
    assert.equal(emitBlocks.length, 2, 'expected the save + disable backfill emit blocks');
    for (const block of emitBlocks) {
      assert.doesNotMatch(block, /rule_code:\s*'IR-\d+'/,
        'memory.js backfill must not hardcode a personal iron-rule code');
      assert.doesNotMatch(block, /學到東西必須全層同步更新/,
        'memory.js backfill must not carry a specific user\'s verbatim rule title');
      assert.match(block, /triggered_by_event:\s*RULE_FULL_LAYER_SYNC/,
        'memory.js backfill must tag the neutral triggered_by_event');
    }
  });

  it('mcp/index.js compliance emit no longer hardcodes a personal iron-rule code', () => {
    const src = read('mcp/index.js');
    const start = src.indexOf('async function autoComplyForToolCall');
    const region = src.slice(start, start + 2200);
    assert.doesNotMatch(region, /rule_code:\s*'IR-\d+'/,
      'mcp emit must not hardcode rule_code: IR-XXX');
    assert.match(region, /triggered_by_event/,
      'mcp emit must set triggered_by_event');
  });

  it('me.js expect side keys on the neutral event, not a bare personal code', () => {
    const src = read('src/routes/me.js');
    // No query may use a bare personal code as its expected_rules value.
    assert.doesNotMatch(src, /ARRAY\['IR-\d+'\]/,
      'me.js expected_rules must not be a bare personal iron-rule code');
    // The functional complianceGapQ must match on the neutral event.
    assert.match(src, /triggered_by_event/,
      'me.js must match compliance rows on the neutral triggered_by_event');
    // The neutral event constant must be imported and used (single source of
    // truth) rather than a hardcoded string or personal code.
    assert.match(src, /import \{[^}]*RULE_FULL_LAYER_SYNC[^}]*\} from '\.\.\/\.\.\/shared\/lint-event-types\.js'/,
      'me.js must import the neutral RULE_FULL_LAYER_SYNC constant');
    assert.match(src, /ARRAY\['\$\{RULE_FULL_LAYER_SYNC\}'\]/,
      'me.js expected_rules must reference the neutral event constant');
    // No query may still compare the personal-coded rule_code against the
    // (now neutral) expected_rules — that would never match and would flag
    // false compliance gaps. Both functional predicates must key on the event.
    assert.doesNotMatch(src, /rule_code'\s*=\s*ANY\(s\.expected_rules\)/,
      'me.js must not compare rule_code against the neutral expected_rules');
  });
});
