// v1.26.129 — every field the init response sends has to be accounted for by the hook.
//
// The bug this generalises (v1.26.128): `/api/memory/init` returned `team_standards_digest`
// on the compact path — the path the hook uses — and `render-session-context.js` never read
// it. A team's standards were loaded for anyone whose tool calls `ownmind_init` and dropped
// for every Claude Code user. Uploaded, sent, never delivered.
//
// It hid because the symptom is an AI that does not follow a rule, which reads as an
// unreliable AI rather than as a rule that never arrived. Nobody reports that.
//
// So the list is grown rather than written: parse what the route actually sends, subtract
// what the renderer actually reads, and require a stated reason for the remainder. Add a
// field to the response and this goes red until someone decides where it goes.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

/**
 * Fields the hook has no business rendering, and why. A reason is required: "we do not show
 * it" is the sentence that let team_standards_digest sit unread for as long as it did.
 */
const NOT_FOR_THE_SESSION_CONTEXT = {
  sync_token: 'transport — consumed by the sync client, never shown',
  allowed_types: 'schema for the save/update tools, not context for the AI',
  compact: 'echo of the request parameter',
  team_standards_hash: 'change detection for the sync path',
  last_team_standard_update: 'change detection for the sync path',
  iron_rules_count: 'superseded by iron_rules_tier_counts, which is rendered',
  instructions: 'non-compact only; the hook never asks for it',
  iron_rules: 'non-compact only; the hook renders iron_rules_digest instead',
  team_standards: 'non-compact only; the hook renders team_standards_digest instead',
  upgrade_action: 'the hook runs its own daily updater (ownmind-session-start.js); it does '
    + 'not need the server to tell the AI to upgrade',
};

/**
 * Fields that ARE for the user and that the hook still drops. Same bug as v1.26.128, not yet
 * fixed — recorded rather than hidden, because an undocumented gap is indistinguishable from
 * a decision. The count may shrink; it may not grow.
 */
const KNOWN_GAPS = {
  weekly_summary: 'a once-a-week recap the Claude Code user never sees',
  memory_health: 'memory health warnings, dropped on this path',
  pending_review: 'items waiting on the user, dropped on this path',
  enforcement_alerts: 'iron rule enforcement alerts, dropped on this path',
  _onboarding: 'the onboarding question for a brand-new user — configs/CLAUDE.md requires the '
    + 'AI to ask it, and on this path the AI is never given it',
};

/** Keys of the object literal `res.json({...})` at the end of the init route. */
function initResponseFields() {
  const src = read('src/routes/memory.js');
  const start = src.indexOf('    res.json({\n      sync_token:');
  assert.ok(start > -1, 'the init route no longer ends with res.json({ sync_token: … }');
  const end = src.indexOf('\n    });', start);
  assert.ok(end > start, 'could not find the end of the init response literal');
  const body = src.slice(start, end);
  // Three shapes: `key: value`, the shorthand `key,` (which `compact` uses — missing it made
  // the classification lists look stale rather than the field look uncovered), and the same
  // inside `...(!compact && { key: … })`.
  const keys = [
    ...body.matchAll(/^\s{6}([A-Za-z_][\w]*):/gm),
    ...body.matchAll(/^\s{6}([A-Za-z_][\w]*),\s*$/gm),
    ...body.matchAll(/&&\s*\{\s*([A-Za-z_][\w]*):/g),
  ].map((m) => m[1]);
  assert.ok(keys.length > 15, `only ${keys.length} response fields parsed — the extraction broke`);
  return [...new Set(keys)];
}

/** Fields `renderSessionContext` reads off the init response. */
function renderedFields() {
  const src = read('hooks/lib/render-session-context.js');
  const keys = [...src.matchAll(/\bd\.([a-z_][\w]*)/g)].map((m) => m[1]);
  assert.ok(keys.length > 3, `only ${keys.length} reads found — the extraction broke`);
  return new Set(keys);
}

describe('the SessionStart context accounts for everything init sends', () => {
  const fields = initResponseFields();
  const rendered = renderedFields();

  it('reads the fields it is supposed to read', () => {
    // Guards the extraction itself: if this regex stopped matching, every field below would
    // look unrendered and the accounted-for check would pass by way of the gap lists.
    for (const key of ['profile', 'iron_rules_digest', 'team_standards_digest', 'active_handoff']) {
      assert.ok(rendered.has(key), `render-session-context.js no longer reads ${key}`);
    }
  });

  it('every field is rendered, excused, or a recorded gap', () => {
    const unaccounted = fields.filter((f) => !rendered.has(f)
      && !(f in NOT_FOR_THE_SESSION_CONTEXT)
      && !(f in KNOWN_GAPS));
    assert.deepEqual(
      unaccounted, [],
      'the init response gained a field the SessionStart context neither renders nor excuses: '
      + `${unaccounted.join(', ')}. Render it, or add it to NOT_FOR_THE_SESSION_CONTEXT with a `
      + 'reason. Silently dropping it is how team standards went missing for every Claude '
      + 'Code user.',
    );
  });

  it('the gap list does not grow', () => {
    // It may shrink — fixing one means deleting its entry. Growing it means a new field was
    // waved through as "known", which is the excuse this file exists to remove.
    assert.ok(
      Object.keys(KNOWN_GAPS).length <= 5,
      `KNOWN_GAPS is up to ${Object.keys(KNOWN_GAPS).length} — fix one instead of adding one`,
    );
  });

  it('nothing is both excused and a gap', () => {
    const both = Object.keys(KNOWN_GAPS).filter((k) => k in NOT_FOR_THE_SESSION_CONTEXT);
    assert.deepEqual(both, [], `contradictory classification: ${both.join(', ')}`);
  });

  it('every excuse and every gap names a field the response still sends', () => {
    // Otherwise the lists rot: a field gets renamed, its entry stays, and the entry silently
    // stops covering anything while still looking like coverage.
    const sent = new Set(fields);
    for (const key of [...Object.keys(NOT_FOR_THE_SESSION_CONTEXT), ...Object.keys(KNOWN_GAPS)]) {
      assert.ok(sent.has(key), `${key} is classified here but the init response no longer sends it`);
    }
  });
});
