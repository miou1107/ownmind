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
 * v1.17.89 — fix the "disable rule '(not found)'" observability black hole
 *
 * Background (v1.17.88 pitfalls page showed 30 missing-observability rows, almost all
 * "disable rule '(not found)'"):
 *   - The client MCP calls logEvent('memory_disable', { id, reason }) on ownmind_disable,
 *     sent to the server; the server writes only { id, reason } into activity_logs.details.
 *   - Later when admin views /api/me/pitfalls, me.js relies on a subquery JOIN against
 *     memories to recover title/code.
 *   - Failure modes: id is non-numeric (the `^\d+$` regex misses), the memory has been
 *     deleted, or the user does not match — the subquery returns null, the page shows
 *     "(not found)", and the admin cannot trace which rule was disabled.
 *
 * Fix: when activity batch arrives on the server, if the event is memory_disable / memory_update
 *   targeting an iron_rule, look up the memory and snapshot code+title into event.details
 *   immediately; future activity_log reads no longer need a JOIN to have full information.
 *
 * Backward compatibility: me.js pitfalls SQL is changed to "read the details snapshot first,
 * fall back to JOIN only if missing."
 */

describe('enrichActivityDetails — snapshot title+code for disable/update events', () => {
  // Simulate DB lookup: given id, return the matching memories row (or null).
  const makeLookup = (rows) => async (id) => rows[id] || null;

  it('memory_disable + iron_rule: fills in disabled_code + disabled_title', async () => {
    const lookup = makeLookup({
      42: { type: 'iron_rule', code: 'IR-099', title: '測試鐵律' },
    });
    const event = { event: 'memory_disable', details: { id: 42, reason: '不需要了' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.disabled_code, 'IR-099');
    assert.equal(enriched.disabled_title, '測試鐵律');
    // Original fields preserved.
    assert.equal(enriched.id, 42);
    assert.equal(enriched.reason, '不需要了');
  });

  it('memory_disable + non-iron_rule: snapshot disabled_type (for pitfalls filter) but not code/title', async () => {
    // v1.17.90: rewrites v1.17.89 behavior.
    // Every memory type's disable must snapshot disabled_type; otherwise the pitfalls SQL
    // cannot filter team_standard / project disables out of the sensitive list.
    // (Of the v1.17.88 30 missing-observability rows, 22 were team_standard / project /
    // standard_detail being miscounted as iron_rule sensitive events.)
    const lookup = makeLookup({
      55: { type: 'preference', code: null, title: '我的偏好' },
    });
    const event = { event: 'memory_disable', details: { id: 55, reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.disabled_type, 'preference', 'must snapshot type so pitfalls SQL can filter');
    assert.equal(enriched.disabled_code, undefined, 'non-iron_rule must not snapshot code');
    assert.equal(enriched.disabled_title, undefined, 'non-iron_rule must not snapshot title');
  });

  it('memory_disable + team_standard: snapshot disabled_type=team_standard (the v1.17.90 main scenario)', async () => {
    const lookup = makeLookup({
      199: { type: 'team_standard', code: null, title: 'gitlab-migration-standard' },
    });
    const event = { event: 'memory_disable', details: { id: 199, reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.disabled_type, 'team_standard');
    assert.equal(enriched.disabled_code, undefined);
  });

  it('memory_disable + iron_rule: also snapshot disabled_type=iron_rule (for SQL filter)', async () => {
    // Confirms v1.17.89 existing behavior (snapshot code+title) + v1.17.90 new behavior (snapshot type) coexist.
    const lookup = makeLookup({
      42: { type: 'iron_rule', code: 'IR-099', title: '測試鐵律' },
    });
    const event = { event: 'memory_disable', details: { id: 42, reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.disabled_type, 'iron_rule');
    assert.equal(enriched.disabled_code, 'IR-099');
    assert.equal(enriched.disabled_title, '測試鐵律');
  });

  it('memory_disable + non-numeric id: skip lookup; do not crash', async () => {
    const lookup = makeLookup({});
    const event = { event: 'memory_disable', details: { id: 'IR-099', reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    // Original details preserved, no error.
    assert.equal(enriched.id, 'IR-099');
    assert.equal(enriched.disabled_code, undefined);
  });

  it('memory_disable + memory already deleted (lookup returns null): do not crash, details unchanged', async () => {
    const lookup = makeLookup({});
    const event = { event: 'memory_disable', details: { id: 999, reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.id, 999);
    assert.equal(enriched.disabled_title, undefined);
  });

  it('memory_update + iron_rule: also fills disabled_code/disabled_title (traceable after update)', async () => {
    const lookup = makeLookup({
      7: { type: 'iron_rule', code: 'IR-007', title: 'Persistent Bug Protocol' },
    });
    const event = { event: 'memory_update', details: { id: 7 } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.disabled_code, 'IR-007');
    assert.equal(enriched.disabled_title, 'Persistent Bug Protocol');
  });

  it('non-disable/update event (e.g. memory_save): details untouched', async () => {
    const lookup = makeLookup({
      1: { type: 'iron_rule', code: 'IR-001', title: 'x' },
    });
    const event = { event: 'memory_save', details: { id: 1, title: '已經有 title 了' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.disabled_code, undefined);
    assert.equal(enriched.title, '已經有 title 了');  // unchanged
  });

  it('event.details missing id: returns original details, no crash', async () => {
    const lookup = makeLookup({});
    const event = { event: 'memory_disable', details: { reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.deepEqual(enriched, { reason: 'x' });
  });

  it('event.details is null: returns {}, no crash', async () => {
    const lookup = makeLookup({});
    const event = { event: 'memory_disable', details: null };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.deepEqual(enriched, {});
  });

  it('lookup function throws: swallow, return original details (enrich must not block the main INSERT)', async () => {
    const lookup = async () => { throw new Error('db down'); };
    const event = { event: 'memory_disable', details: { id: 42, reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.id, 42);
    assert.equal(enriched.disabled_title, undefined);
  });
});

describe('activity.js batch handler integration — enrich before DB write', () => {
  const activitySource = fs.readFileSync(path.join(repoRoot, 'src/routes/activity.js'), 'utf8');

  it('activity.js imports enrichActivityDetails', () => {
    assert.match(activitySource, /import\s*\{\s*enrichActivityDetails\s*\}\s*from\s*['"]\.\.\/utils\/enrich-activity\.js['"]/,
      'activity.js should import enrichActivityDetails');
  });

  it('batch handler calls enrichActivityDetails before INSERT', () => {
    // Grab the code block leading up to INSERT.
    const m = activitySource.match(/router\.post\('\/batch'[\s\S]+?INSERT INTO activity_logs/);
    assert.ok(m, 'batch handler INSERT not found');
    assert.match(m[0], /enrichActivityDetails/, 'batch handler must enrich details before INSERT');
  });
});

describe('memory.js disable route — should also enrich activity log (direct server-route path)', () => {
  // The disable route itself INSERTs iron_rule_compliance, but activity_logs.memory_disable
  // is still written by the client logEvent. The simplest fix for this black hole is to enrich
  // in the server batch handler — the disable route does not need to change, because the
  // client will batch-upload eventually.
  // For race-condition safety (admin querying pitfalls before client upload), the disable route
  // should also proactively log a memory_disable activity entry (with the full snapshot).
  // Skipping this test for now — leave it for v1.17.90 to evaluate.
});

describe('me.js pitfalls SQL — read the details snapshot first, fall back to JOIN', () => {
  const meSource = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');

  it('unobserved query uses COALESCE(details snapshot, JOIN memories) for disabled_title', () => {
    // Find the unobservedQ block.
    const m = meSource.match(/Section 1: unobserved[\s\S]+?ORDER BY s\.ts DESC/);
    assert.ok(m, 'unobserved query not found');
    // It must COALESCE details->>'disabled_title' with the JOIN result.
    assert.match(m[0], /COALESCE\s*\(\s*s\.details->>'disabled_title'/,
      'unobserved query must read details->>disabled_title first');
    assert.match(m[0], /COALESCE\s*\(\s*s\.details->>'disabled_code'/,
      'unobserved query must read details->>disabled_code first');
  });

  it('unverified query also reads the details snapshot first', () => {
    const m = meSource.match(/Section 2: unverified[\s\S]+?ORDER BY s\.ts DESC/);
    assert.ok(m, 'unverified query not found');
    assert.match(m[0], /COALESCE\s*\(\s*s\.details->>'disabled_title'/,
      'unverified query must read details->>disabled_title first');
  });
});

describe('v1.17.90 — me.js pitfalls SQL must filter out non-iron_rule disables', () => {
  // Background: v1.17.88 pitfalls showed 30 missing-observability rows; prod DB query results:
  //   22 rows were team_standard / standard_detail / project disable (miscounted as sensitive)
  //   8 rows were iron_rule save that genuinely lacked compliance
  //   73% false positive rate.
  // Fix: the memory_disable branch of the sensitive CTE must filter on type='iron_rule'.
  const meSource = fs.readFileSync(path.join(repoRoot, 'src/routes/me.js'), 'utf8');

  it('unobserved sensitive CTE memory_disable branch must filter for iron_rule', () => {
    const m = meSource.match(/Section 1: unobserved[\s\S]+?ORDER BY s\.ts DESC/);
    assert.ok(m, 'unobserved query not found');
    // Read details snapshot with COALESCE / fallback JOIN memories — either condition must be iron_rule.
    // Accept either form: inline COALESCE in WHERE, or SELECT mem_type then WHERE.
    // Note: use [\s\S]* instead of .* because SQL spans multiple lines.
    assert.match(m[0], /disabled_type[\s\S]*?iron_rule|memory_type[\s\S]*?iron_rule|m\.type[\s\S]*?iron_rule/,
      'unobserved sensitive list memory_disable must count only iron_rule (other types must not trigger IR-006)');
  });

  it('unverified sensitive CTE memory_disable branch must also filter for iron_rule', () => {
    const m = meSource.match(/Section 2: unverified[\s\S]+?ORDER BY s\.ts DESC/);
    assert.ok(m, 'unverified query not found');
    assert.match(m[0], /disabled_type[\s\S]*?iron_rule|memory_type[\s\S]*?iron_rule|m\.type[\s\S]*?iron_rule/,
      'unverified sensitive list memory_disable must count only iron_rule');
  });
});

describe('v1.17.90 — enrichActivityDetails snapshots disabled_type for every memory type', () => {
  // So me.js pitfalls SQL doesn't need to JOIN memories per row to filter iron_rule disables,
  // enrich should write disabled_type into details for every type.
  it('preference, project, team_standard, standard_detail all get disabled_type snapshot', async () => {
    const types = ['preference', 'project', 'team_standard', 'standard_detail'];
    for (const t of types) {
      const lookup = async () => ({ type: t, code: null, title: 'x' });
      const event = { event: 'memory_disable', details: { id: 1, reason: 'x' } };
      const enriched = await enrichActivityDetails(event, lookup);
      assert.equal(enriched.disabled_type, t, `type=${t} should be snapshot to disabled_type`);
      assert.equal(enriched.disabled_code, undefined, `type=${t} must not snapshot code`);
    }
  });

  it('defensive boundary: lookup returns a row whose type is null (schema NOT NULL; should never happen)', async () => {
    // Reviewer minor #6: if a row exists but type is null (schema violation),
    // disabled_type will be written as null. The pitfalls SQL's COALESCE(snapshot, JOIN)
    // sees JSONB null and falls back to JOIN, so the correct type still gets filtered.
    const lookup = async () => ({ type: null, code: null, title: null });
    const event = { event: 'memory_disable', details: { id: 1, reason: 'x' } };
    const enriched = await enrichActivityDetails(event, lookup);
    assert.equal(enriched.disabled_type, null, 'type=null written as null (not undefined) so COALESCE can fall back');
    assert.equal(enriched.disabled_code, undefined, 'non-iron_rule must not snapshot code');
  });
});
