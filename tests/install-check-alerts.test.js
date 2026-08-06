// tests/install-check-alerts.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateFailures, stateKey } from '../src/lib/install-check-alerts.js';

// Real payload from production, machine LAPTOP-MBGGLV2J, client 1.26.84.
const ADAM_MEMORY_LOAD_FAIL = {
  name: 'memory_load',
  status: 'fail',
  detail: 'memories have never loaded automatically on this account (`bash` on this machine is the WSL launcher, whose home directory is not this one)',
  fix: 'Re-run the installer, then fully restart your AI tool and open a new conversation',
};

function adamReport(checks) {
  return {
    user_id: 3,
    user_name: 'Adam',
    machine: 'LAPTOP-MBGGLV2J',
    client_version: '1.26.84',
    checks,
  };
}

function announced(overrides = {}) {
  return {
    user_id: 3,
    machine: 'LAPTOP-MBGGLV2J',
    check_name: 'memory_load',
    detail: ADAM_MEMORY_LOAD_FAIL.detail,
    announced_at: new Date('2026-08-06T00:00:00Z'),
    resolved_at: null,
    ...overrides,
  };
}

describe('evaluateFailures — first sighting', () => {
  it('a failure nobody has announced is new', () => {
    const { newFailures } = evaluateFailures({
      reports: [adamReport([{ name: 'scheduler', status: 'pass', detail: 'ok' }, ADAM_MEMORY_LOAD_FAIL])],
      knownState: [],
    });
    assert.equal(newFailures.length, 1);
    assert.deepEqual(newFailures[0], {
      user_id: 3,
      user_name: 'Adam',
      machine: 'LAPTOP-MBGGLV2J',
      check_name: 'memory_load',
      detail: ADAM_MEMORY_LOAD_FAIL.detail,
      fix: ADAM_MEMORY_LOAD_FAIL.fix,
      client_version: '1.26.84',
    });
  });

  it('an all-green report produces nothing', () => {
    const { newFailures, resolved } = evaluateFailures({
      reports: [adamReport([{ name: 'scheduler', status: 'pass', detail: 'ok' }])],
      knownState: [],
    });
    assert.equal(newFailures.length, 0);
    assert.equal(resolved.length, 0);
  });

  it('warn is not a failure', () => {
    const { newFailures } = evaluateFailures({
      reports: [adamReport([{ name: 'api_key_source', status: 'warn', detail: 'key only in env' }])],
      knownState: [],
    });
    assert.equal(newFailures.length, 0);
  });
});

describe('evaluateFailures — announce once', () => {
  it('the same failure already announced is not new again', () => {
    const { newFailures } = evaluateFailures({
      reports: [adamReport([ADAM_MEMORY_LOAD_FAIL])],
      knownState: [announced()],
    });
    assert.equal(newFailures.length, 0);
  });

  it('running twice over the same input announces nothing the second time', () => {
    const reports = [adamReport([ADAM_MEMORY_LOAD_FAIL])];
    const first = evaluateFailures({ reports, knownState: [] });
    assert.equal(first.newFailures.length, 1);

    // what the job would have written after the first run
    const stateAfterFirst = first.newFailures.map((f) => ({
      user_id: f.user_id,
      machine: f.machine,
      check_name: f.check_name,
      detail: f.detail,
      announced_at: new Date('2026-08-06T10:00:00Z'),
      resolved_at: null,
    }));

    const second = evaluateFailures({ reports, knownState: stateAfterFirst });
    assert.equal(second.newFailures.length, 0, 'second run must be silent');
  });

  it('a reworded detail updates the record but does not re-announce', () => {
    const reworded = { ...ADAM_MEMORY_LOAD_FAIL, detail: 'memories never load: bash here is the WSL launcher' };
    const { newFailures, detailChanges } = evaluateFailures({
      reports: [adamReport([reworded])],
      knownState: [announced()],
    });
    assert.equal(newFailures.length, 0);
    assert.deepEqual(detailChanges, [{
      user_id: 3, machine: 'LAPTOP-MBGGLV2J', check_name: 'memory_load', detail: reworded.detail,
    }]);
  });
});

describe('evaluateFailures — resolution re-arms', () => {
  it('a previously announced check that now passes is resolved', () => {
    const { resolved, newFailures } = evaluateFailures({
      reports: [adamReport([{ name: 'memory_load', status: 'pass', detail: 'loaded 3 memories' }])],
      knownState: [announced()],
    });
    assert.deepEqual(resolved, [{ user_id: 3, machine: 'LAPTOP-MBGGLV2J', check_name: 'memory_load' }]);
    assert.equal(newFailures.length, 0);
  });

  it('failing again after being resolved is announced again', () => {
    const { newFailures } = evaluateFailures({
      reports: [adamReport([ADAM_MEMORY_LOAD_FAIL])],
      knownState: [announced({ resolved_at: new Date('2026-08-06T09:00:00Z') })],
    });
    assert.equal(newFailures.length, 1);
  });
});

describe('evaluateFailures — a report without checks decides nothing', () => {
  it('a beacon row does not resolve a live failure', () => {
    const { resolved, newFailures } = evaluateFailures({
      reports: [adamReport([])],
      knownState: [announced()],
    });
    assert.equal(resolved.length, 0, 'an empty report must not read as "fixed"');
    assert.equal(newFailures.length, 0);
  });

  it('a check absent from the report is left alone, not resolved', () => {
    const { resolved } = evaluateFailures({
      reports: [adamReport([{ name: 'scheduler', status: 'pass', detail: 'ok' }])],
      knownState: [announced()],
    });
    assert.equal(resolved.length, 0);
  });
});

describe('evaluateFailures — deduplicate within a single call', () => {
  it('three copies of the same failing report produce one newFailures entry', () => {
    const reports = [
      adamReport([ADAM_MEMORY_LOAD_FAIL]),
      adamReport([ADAM_MEMORY_LOAD_FAIL]),
      adamReport([ADAM_MEMORY_LOAD_FAIL]),
    ];
    const { newFailures } = evaluateFailures({ reports, knownState: [] });
    assert.equal(newFailures.length, 1);
    assert.equal(newFailures[0].check_name, 'memory_load');
  });

  it('the same resolved check in multiple reports produces one resolved entry', () => {
    const reports = [
      adamReport([{ name: 'memory_load', status: 'pass', detail: 'loaded 3 memories' }]),
      adamReport([{ name: 'memory_load', status: 'pass', detail: 'loaded 3 memories' }]),
      adamReport([{ name: 'memory_load', status: 'pass', detail: 'loaded 3 memories' }]),
    ];
    const { resolved } = evaluateFailures({
      reports,
      knownState: [announced()],
    });
    assert.equal(resolved.length, 1);
    assert.deepEqual(resolved[0], { user_id: 3, machine: 'LAPTOP-MBGGLV2J', check_name: 'memory_load' });
  });

  it('two different machines failing the same check produce two newFailures entries', () => {
    const reports = [
      adamReport([ADAM_MEMORY_LOAD_FAIL]),
      {
        user_id: 3,
        user_name: 'Adam',
        machine: 'ANOTHER-MACHINE',
        client_version: '1.26.84',
        checks: [ADAM_MEMORY_LOAD_FAIL],
      },
    ];
    const { newFailures } = evaluateFailures({ reports, knownState: [] });
    assert.equal(newFailures.length, 2);
    assert.notEqual(newFailures[0].machine, newFailures[1].machine);
  });

  it('same (user, machine), first report fail then later report pass → only first report matters, result is one newFailure', () => {
    const reports = [
      adamReport([ADAM_MEMORY_LOAD_FAIL]),  // First report: check is failing
      adamReport([{ name: 'memory_load', status: 'pass', detail: 'loaded 3 memories' }]),  // Later report: same check passing
    ];
    const { newFailures, resolved } = evaluateFailures({ reports, knownState: [] });
    assert.equal(newFailures.length, 1, 'should have one newFailure from the first report');
    assert.equal(resolved.length, 0, 'second report is ignored, so nothing is resolved');
  });

  it('same (user, machine), first report pass then later report fail → only first report matters, result is one resolved', () => {
    const reports = [
      adamReport([{ name: 'memory_load', status: 'pass', detail: 'loaded 3 memories' }]),  // First report: check is passing
      adamReport([ADAM_MEMORY_LOAD_FAIL]),  // Later report: same check failing
    ];
    const { newFailures, resolved } = evaluateFailures({
      reports,
      knownState: [announced()],  // Check was previously announced and unresolved
    });
    assert.equal(newFailures.length, 0, 'second report is ignored, so nothing is re-announced');
    assert.equal(resolved.length, 1, 'should have one resolved from the first report');
  });

  it('newest report covers memory_load, older report carries different check scheduler → older report ignored entirely, stale checks not added', () => {
    const reports = [
      adamReport([ADAM_MEMORY_LOAD_FAIL]),  // Newest: memory_load failing
      adamReport([{ name: 'scheduler', status: 'fail', detail: 'cron job failed', fix: 'check cron' }]),  // Older: scheduler failing (different check)
    ];
    const { newFailures } = evaluateFailures({ reports, knownState: [] });
    // Oldest report should be skipped entirely (report-level dedupe), not just its checks ignored.
    // Only the newest report's checks (memory_load) should be processed.
    assert.equal(newFailures.length, 1, 'only newest report is processed, older report ignored');
    assert.equal(newFailures[0].check_name, 'memory_load', 'result contains only the check from newest report');
  });
});

describe('stateKey', () => {
  it('distinguishes machines that share a check name', () => {
    assert.notEqual(stateKey(3, 'A', 'memory_load'), stateKey(3, 'B', 'memory_load'));
  });

  it('distinguishes users that share a machine name', () => {
    assert.notEqual(stateKey(3, 'TANK', 'memory_load'), stateKey(11, 'TANK', 'memory_load'));
  });
});
