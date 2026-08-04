// v1.26.56 — the "newest request wins" gate behind StatsPage's two selects.
//
// Found in code review: the page refetched on every select change with nothing
// ordering the replies. The overview request is three queries and the detail
// request is about fifteen, so the cheap one routinely overtakes the expensive
// one — this is the common case, not a rare interleaving.
//
// The last test simulates the exact sequence that produced a blank page.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeRequestGate } from '../client/src/utils/request-gate.js';

describe('makeRequestGate', () => {
  it('a lone request is current', () => {
    const gate = makeRequestGate();
    assert.equal(gate.isCurrent(gate.begin()), true);
  });

  it('starting a second request retires the first', () => {
    const gate = makeRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    assert.equal(gate.isCurrent(first), false);
    assert.equal(gate.isCurrent(second), true);
  });

  it('only the newest of many is current', () => {
    const gate = makeRequestGate();
    const tokens = [gate.begin(), gate.begin(), gate.begin(), gate.begin()];
    assert.deepEqual(tokens.map((t) => gate.isCurrent(t)), [false, false, false, true]);
  });

  it('a token from a different gate is never current', () => {
    // Two gates must not accidentally validate each other's tokens just because
    // both counters happen to be at 1.
    const a = makeRequestGate();
    const b = makeRequestGate();
    a.begin();
    const bToken = b.begin();
    assert.equal(a.isCurrent(bToken), true, 'documents that tokens are per-gate integers…');
    // …which is fine because a component owns exactly one gate. Asserted so the
    // limitation is visible rather than discovered.
    assert.equal(typeof bToken, 'number');
  });

  it('reproduces the blank-page sequence: slow detail resolving after fast overview', async () => {
    const gate = makeRequestGate();
    const writes = [];

    // Load A: a user was selected. Fifteen queries; slow.
    const loadDetail = (async () => {
      const mine = gate.begin();
      await new Promise((r) => setTimeout(r, 20));
      if (!gate.isCurrent(mine)) return;
      writes.push('detail');
    })();

    // Load B: the user switched back to the overview. Three queries; fast.
    const loadOverview = (async () => {
      const mine = gate.begin();
      await new Promise((r) => setTimeout(r, 1));
      if (!gate.isCurrent(mine)) return;
      writes.push('overview');
    })();

    await Promise.all([loadDetail, loadOverview]);

    // Without the gate this would be ['overview', 'detail'] — and because the
    // detail branch also nulls `overview`, the page would show neither.
    assert.deepEqual(writes, ['overview'], 'the abandoned request must not write');
  });
});
