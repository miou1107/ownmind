// v1.26.51 — workLogRowVm() turns a merged-timeline row into what one <tr>
// needs. The three things that matter:
//
//   1. Empty details ⇒ `—`, not `{}`. The legacy JS explicitly checks
//      `Object.keys(details).length > 0` to avoid printing `{}` as noise.
//   2. summary wins over details when both are present (session rows).
//   3. detailsPreview is truncated to 200 chars; detailsFull carries the
//      whole string (goes into the cell's title attribute for hover).
//
// The three source-badge colours are asserted so a future edit that
// swaps them can be caught.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { workLogRowVm } from '../client/src/pages/System/work-log-row-vm.js';

function row(overrides = {}) {
  return {
    source: 'activity',
    row_id: 1,
    user_id: 7,
    user_name: 'Alice',
    ts: '2026-07-15T04:30:22.000Z',
    event_type: 'init',
    tool: 'claude-code',
    event_source: 'user',
    details: {},
    title: null,
    summary: null,
    ...overrides,
  };
}

describe('workLogRowVm — source colouring', () => {
  it('every source maps to a distinct colour', () => {
    assert.equal(workLogRowVm(row({ source: 'activity' })).sourceColor, 'activity');
    assert.equal(workLogRowVm(row({ source: 'compliance' })).sourceColor, 'compliance');
    assert.equal(workLogRowVm(row({ source: 'session' })).sourceColor, 'session');
  });

  it('unknown source falls back to a neutral colour, not crash', () => {
    // Defensive: the API's UNION could grow a fourth source in future.
    assert.equal(workLogRowVm(row({ source: 'future' })).sourceColor, 'unknown');
  });
});

describe('workLogRowVm — user resolution', () => {
  it('prefers user_name from the row', () => {
    assert.equal(workLogRowVm(row({ user_name: 'Bob' })).userLabel, 'Bob');
  });

  it('falls back to user#{id} when user_name is missing', () => {
    // Server LEFT JOINs to users; a deleted user leaves user_name null.
    assert.equal(
      workLogRowVm(row({ user_name: null, user_id: 42 })).userLabel,
      'user#42',
    );
  });
});

describe('workLogRowVm — details preview', () => {
  it('empty {} details render — not {}', () => {
    const vm = workLogRowVm(row({ details: {} }));
    assert.equal(vm.detailsPreview, '—');
  });

  it('null details render — not "null"', () => {
    const vm = workLogRowVm(row({ details: null }));
    assert.equal(vm.detailsPreview, '—');
  });

  it('non-empty details render as JSON', () => {
    const vm = workLogRowVm(row({ details: { key: 'value' } }));
    assert.match(vm.detailsPreview, /"key":\s*"value"/);
  });

  it('summary wins over details when both present', () => {
    const vm = workLogRowVm(row({
      source: 'session',
      summary: 'AI session summary',
      details: { some: 'data' },
    }));
    assert.equal(vm.detailsPreview, 'AI session summary');
  });

  it('summary alone (no details) is used', () => {
    const vm = workLogRowVm(row({
      source: 'session',
      summary: 'Just a summary',
      details: null,
    }));
    assert.equal(vm.detailsPreview, 'Just a summary');
  });
});

describe('workLogRowVm — truncation', () => {
  it('preview truncates to 200 chars, full carries the whole string', () => {
    const longString = 'x'.repeat(350);
    const vm = workLogRowVm(row({
      source: 'session',
      summary: longString,
    }));
    assert.equal(vm.detailsPreview.length, 200);
    assert.equal(vm.detailsFull.length, 350);
  });

  it('short strings are not padded, both preview and full match', () => {
    const vm = workLogRowVm(row({
      source: 'session',
      summary: 'short',
    }));
    assert.equal(vm.detailsPreview, 'short');
    assert.equal(vm.detailsFull, 'short');
  });
});

describe('workLogRowVm — tool / event / timestamp passthroughs', () => {
  it('empty tool renders — for readability', () => {
    assert.equal(workLogRowVm(row({ tool: null })).toolLabel, '—');
    assert.equal(workLogRowVm(row({ tool: '' })).toolLabel, '—');
  });

  it('event_type is preserved raw for both display and tooltip', () => {
    const vm = workLogRowVm(row({ event_type: 'iron_rule_compliance' }));
    assert.equal(vm.eventLabel, 'iron_rule_compliance');
  });
});
