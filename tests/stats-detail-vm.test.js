// v1.26.56 — the single-user detail blocks: 記憶數量卡片, 系統健康, 交接統計,
// and the four context blocks (常用操作 / 專案分布 / 使用者痛點 / AI 改善建議).
//
// The context section is the interesting one. The legacy page responds to
// `context: null` with `classList.add('hidden')` — four blocks silently vanish
// and the reader is left to guess whether the feature is broken, the data is
// missing, or they mis-selected a user. Requirement 7's last scenario says a
// value that could not be computed names the reason. So contextVm always
// returns a shape, and carries a reason key when there is nothing to show.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  memoryCards,
  healthLines,
  handoffLines,
  contextVm,
  CONTEXT_ABSENT_REASON,
} from '../client/src/pages/Team/stats-detail-vm.js';

function detail(overrides = {}) {
  return {
    memory: { total: 100, active: 90, disabled: 10, created_this_period: 4, by_type: {} },
    sessions: { total: 20, by_tool: {}, by_model: {}, compressed: 2, recovered: 0 },
    activity: { total_events: 500, by_event: {}, by_tool: {}, daily: [] },
    iron_rules: { total_active: 88, total_triggers: 12, top_triggered: [] },
    handoffs: { total: 3, completed: 2, pending: 1 },
    health: { init_success_rate: 99.2, sync_conflicts: 0, updates_applied: 5 },
    ...overrides,
  };
}

describe('memoryCards', () => {
  it('carries the eight always-present cards in the legacy order', () => {
    const keys = memoryCards(detail()).map((c) => c.key);
    assert.deepEqual(keys, [
      'memory_total', 'memory_active', 'memory_disabled', 'memory_created',
      'sessions_total', 'activity_events', 'rules_active', 'rule_triggers',
    ]);
  });

  it('adds the auto-recovery card only when something was recovered', () => {
    // Legacy renders it conditionally on `recovered > 0`. A permanent "0 recovered"
    // card is noise on every account that has never crashed.
    assert.equal(memoryCards(detail()).some((c) => c.key === 'sessions_recovered'), false);
    const withRecovery = memoryCards(detail({
      sessions: { total: 20, by_tool: {}, by_model: {}, compressed: 2, recovered: 3 },
    }));
    const card = withRecovery.find((c) => c.key === 'sessions_recovered');
    assert.ok(card, 'recovery card should appear when recovered > 0');
    assert.equal(card.value, 3);
    assert.equal(card.tone, 'warn');
  });

  it('reads the values off the payload', () => {
    const byKey = Object.fromEntries(memoryCards(detail()).map((c) => [c.key, c.value]));
    assert.equal(byKey.memory_total, 100);
    assert.equal(byKey.memory_active, 90);
    assert.equal(byKey.memory_disabled, 10);
    assert.equal(byKey.memory_created, 4);
    assert.equal(byKey.sessions_total, 20);
    assert.equal(byKey.activity_events, 500);
    assert.equal(byKey.rules_active, 88);
    assert.equal(byKey.rule_triggers, 12);
  });
});

describe('healthLines', () => {
  // Every case here needs at least one observed init event, otherwise the rate
  // is unmeasurable — see the block of tests below.
  const withInit = (o = {}) => detail({
    activity: { total_events: 10, by_event: { init: 3 }, by_tool: {}, daily: [] },
    ...o,
  });

  it('bands the init success rate at 95', () => {
    assert.equal(healthLines(withInit()).find((l) => l.key === 'init_rate').band, 'high');
    const low = healthLines(withInit({ health: { init_success_rate: 94.9, sync_conflicts: 0, updates_applied: 0 } }));
    assert.equal(low.find((l) => l.key === 'init_rate').band, 'low');
  });

  // v1.26.56, found by the browser check. src/routes/activity.js computes
  // `(initS + initF) > 0 ? rate : 100`, so an account that never initialised is
  // reported as a flawless 100%. The e2e fixture rendered exactly that, in green.
  it('an init rate with no init events behind it is unmeasured, not 100%', () => {
    const line = healthLines(detail()).find((l) => l.key === 'init_rate');
    assert.equal(line.value, null, 'must not repeat the server\'s fabricated 100');
    assert.equal(line.band, 'unmeasured');
  });

  it('a failed init still counts as measured', () => {
    const d = detail({ health: { init_success_rate: 0, sync_conflicts: 0, updates_applied: 0 },
      activity: { total_events: 2, by_event: { init_fail: 2 }, by_tool: {}, daily: [] } });
    const line = healthLines(d).find((l) => l.key === 'init_rate');
    assert.equal(line.value, 0, 'a real 0% is a real 0%');
    assert.equal(line.band, 'low');
  });

  it('falls back to trusting the number once by_event hits the query LIMIT', () => {
    // GROUP BY event ORDER BY count DESC LIMIT 20: at twenty entries the list
    // may have been truncated, so an absent `init` key proves nothing.
    const byEvent = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`event_${i}`, 20 - i]),
    );
    const d = detail({ activity: { total_events: 210, by_event: byEvent, by_tool: {}, daily: [] } });
    const line = healthLines(d).find((l) => l.key === 'init_rate');
    assert.equal(line.value, 99.2, 'cannot prove absence, so do not overrule the server');
    assert.equal(line.band, 'high');
  });

  it('carries sync conflicts and applied updates unbanded', () => {
    const lines = healthLines(detail());
    const conflicts = lines.find((l) => l.key === 'sync_conflicts');
    const updates = lines.find((l) => l.key === 'updates_applied');
    assert.equal(conflicts.value, 0);
    assert.equal(conflicts.band, null);
    assert.equal(updates.value, 5);
  });
});

describe('handoffLines', () => {
  it('carries total, completed and pending', () => {
    const byKey = Object.fromEntries(handoffLines(detail()).map((l) => [l.key, l.value]));
    assert.equal(byKey.handoff_total, 3);
    assert.equal(byKey.handoff_completed, 2);
    assert.equal(byKey.handoff_pending, 1);
  });
});

describe('contextVm — absence names itself instead of disappearing', () => {
  it('a null context is unavailable and carries a reason', () => {
    const vm = contextVm(null);
    assert.equal(vm.available, false);
    assert.equal(vm.reasonKey, CONTEXT_ABSENT_REASON);
    assert.deepEqual(vm.actions, []);
    assert.deepEqual(vm.projects, []);
    assert.deepEqual(vm.friction, []);
    assert.deepEqual(vm.suggestions, []);
  });

  it('a context with zero sessions is also unavailable', () => {
    const vm = contextVm({ sessions_with_context: 0, top_actions: [], top_projects: [], friction_points: [], suggestions: [] });
    assert.equal(vm.available, false);
    assert.equal(vm.reasonKey, CONTEXT_ABSENT_REASON);
  });

  it('converts the server pair-arrays into chart rows', () => {
    // top_actions / top_projects are Object.entries() output: [[key, count], …]
    const vm = contextVm({
      sessions_with_context: 12,
      avg_turns: 30,
      top_actions: [['code_edit', 40], ['deploy', 10]],
      top_projects: [['ownmind', 8]],
      friction_points: [],
      suggestions: [],
    });
    assert.equal(vm.available, true);
    assert.equal(vm.reasonKey, null);
    assert.deepEqual(vm.actions.map((r) => r.key), ['code_edit', 'deploy']);
    assert.deepEqual(vm.actions.map((r) => r.pct), [100, 25]);
    assert.deepEqual(vm.projects.map((r) => r.key), ['ownmind']);
    assert.equal(vm.sessionsWithContext, 12);
    assert.equal(vm.avgTurns, 30);
  });

  it('available but with an empty sub-list keeps the siblings rendering', () => {
    // Requirement 6's second scenario: one empty block must not blank the section.
    const vm = contextVm({
      sessions_with_context: 5,
      avg_turns: null,
      top_actions: [['deploy', 2]],
      top_projects: [],
      friction_points: [],
      suggestions: [{ tool: 'claude-code', text: 'add a retry' }],
    });
    assert.equal(vm.available, true);
    assert.deepEqual(vm.friction, []);
    assert.equal(vm.suggestions.length, 1);
    assert.equal(vm.actions.length, 1, 'a sibling with data still renders it');
    assert.equal(vm.avgTurns, null);
  });

  it('tolerates missing arrays on an otherwise present context', () => {
    const vm = contextVm({ sessions_with_context: 3 });
    assert.equal(vm.available, true);
    assert.deepEqual(vm.actions, []);
    assert.deepEqual(vm.friction, []);
  });
});
