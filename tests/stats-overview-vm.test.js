// v1.26.56 — overviewRowVm() turns one row of GET /api/activity/stats/all into
// what one <tr> of the 用戶活躍度總表 needs.
//
// Three things this file exists to pin:
//
//   1. The activity dot is a seven-day window measured from a caller-supplied
//      "now". The legacy code called Date.now() inline, which makes the rule
//      untestable; the boundary is the whole point of the column.
//   2. compliance_rate arrives as a STRING from /stats/all (the server does
//      .toFixed(1)) or as null. Null is unmeasured, not zero — Requirement 7.
//   3. Tool and model maps are ordered by count descending, and an empty map
//      is marked unmeasured rather than rendered as an empty cell.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { overviewRowVm, ACTIVE_WINDOW_MS } from '../client/src/pages/Team/stats-overview-vm.js';

const NOW = Date.parse('2026-08-04T00:00:00.000Z');

function user(overrides = {}) {
  return {
    id: 7,
    name: 'Alice',
    email: 'alice@example.com',
    memory_count: '12',
    session_count: '5',
    compliance_rate: '95.0',
    tools: { 'claude-code': 3 },
    models: { 'claude-opus-5': 3 },
    last_active: '2026-08-03T10:00:00.000Z',
    ...overrides,
  };
}

describe('overviewRowVm — identity and counts', () => {
  it('prefers name over email, falls back to email', () => {
    assert.equal(overviewRowVm(user(), NOW).label, 'Alice');
    assert.equal(overviewRowVm(user({ name: null }), NOW).label, 'alice@example.com');
  });

  it('coerces the string counts the server sends into numbers', () => {
    // COUNT(*) comes back as a string from pg. Rendering it works by accident;
    // comparing or summing it does not.
    const vm = overviewRowVm(user(), NOW);
    assert.equal(vm.memoryCount, 12);
    assert.equal(vm.sessionCount, 5);
  });

  it('a genuinely zero count is zero, not unmeasured', () => {
    // memory_count is an all-time COUNT(*): it is always computable, so 0 here
    // really means "this user has no memories". Requirement 7's second scenario.
    const vm = overviewRowVm(user({ memory_count: '0' }), NOW);
    assert.equal(vm.memoryCount, 0);
  });
});

describe('overviewRowVm — the seven-day activity window', () => {
  it('the window is seven days', () => {
    assert.equal(ACTIVE_WINDOW_MS, 7 * 86400000);
  });

  it('active six days ago counts as active', () => {
    const vm = overviewRowVm(user({ last_active: new Date(NOW - 6 * 86400000).toISOString() }), NOW);
    assert.equal(vm.isActive, true);
  });

  it('active eight days ago counts as inactive', () => {
    const vm = overviewRowVm(user({ last_active: new Date(NOW - 8 * 86400000).toISOString() }), NOW);
    assert.equal(vm.isActive, false);
  });

  it('exactly at the boundary is inactive, not active', () => {
    // Pinned so a future `<=` does not silently widen the window.
    const vm = overviewRowVm(user({ last_active: new Date(NOW - ACTIVE_WINDOW_MS).toISOString() }), NOW);
    assert.equal(vm.isActive, false);
  });

  it('never active is flagged, not rendered as a date', () => {
    const vm = overviewRowVm(user({ last_active: null }), NOW);
    assert.equal(vm.neverActive, true);
    assert.equal(vm.lastActiveIso, null);
    assert.equal(vm.isActive, false);
  });
});

describe('overviewRowVm — compliance rate is unmeasured or a real number', () => {
  it('a string rate is parsed and banded', () => {
    const vm = overviewRowVm(user({ compliance_rate: '95.0' }), NOW);
    assert.equal(vm.complianceRate, 95);
    assert.equal(vm.complianceBand, 'high');
  });

  it('null is unmeasured, carrying no rate and no colour band', () => {
    // The user has no iron_rule_compliance events in the period. That is an
    // absence of evidence; rendering it as 0% would state a failure we never saw.
    const vm = overviewRowVm(user({ compliance_rate: null }), NOW);
    assert.equal(vm.complianceRate, null);
    assert.equal(vm.complianceBand, 'unmeasured');
  });

  it('a real zero is a real zero', () => {
    const vm = overviewRowVm(user({ compliance_rate: '0.0' }), NOW);
    assert.equal(vm.complianceRate, 0);
    assert.equal(vm.complianceBand, 'low');
  });
});

describe('overviewRowVm — tool and model pills', () => {
  it('orders by count descending', () => {
    const vm = overviewRowVm(user({ tools: { a: 1, b: 9, c: 4 } }), NOW);
    assert.deepEqual(vm.tools.map((p) => p.key), ['b', 'c', 'a']);
    assert.deepEqual(vm.tools.map((p) => p.count), [9, 4, 1]);
  });

  it('an empty map is unmeasured rather than an empty list rendered as a blank cell', () => {
    const vm = overviewRowVm(user({ tools: {}, models: undefined }), NOW);
    assert.deepEqual(vm.tools, []);
    assert.equal(vm.toolsMeasured, false);
    assert.deepEqual(vm.models, []);
    assert.equal(vm.modelsMeasured, false);
  });

  it('a non-empty map is measured', () => {
    const vm = overviewRowVm(user(), NOW);
    assert.equal(vm.toolsMeasured, true);
    assert.equal(vm.modelsMeasured, true);
  });
});
