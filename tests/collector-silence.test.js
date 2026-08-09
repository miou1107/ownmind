import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateSilence, toolsFingerprint, FRESH_DAYS, STALE_DAYS,
} from '../src/lib/collector-silence.js';

/**
 * v1.26.102 — a dead usage collector is detected from disagreement inside one
 * machine, not from absolute silence.
 *
 * The thresholds were chosen against a real snapshot of `collector_heartbeat`
 * (production, 2026-08-07), which is reproduced below rather than described. The
 * point of keeping it is the negative half: ten healthy machines that must stay
 * quiet. A detector that fires on the broken one is easy; one that fires on
 * nobody else is the thing worth pinning.
 *
 * This function reports what is broken **now**, not what is new. Announce-once is
 * decided by the claim statement in the job, because that is also the question
 * two concurrent sweeps must not both answer yes to.
 */

const NOW = new Date('2026-08-07T07:10:00Z');   // 15:10 Asia/Taipei

/** A heartbeat row `days` old. */
function beat(user_id, user_name, machine, tool, days) {
  return {
    user_id,
    user_name,
    machine,
    tool,
    last_reported_at: new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000),
  };
}

const FIVE = ['claude-code', 'codex', 'opencode', 'cursor', 'antigravity'];

/** Every tool on one machine reporting at the same moment, as a healthy one does. */
function healthy(user_id, name, machine, days) {
  return FIVE.map((tool) => beat(user_id, name, machine, tool, days));
}

/**
 * The production snapshot. Ages in days, as measured.
 *
 * Amiee's machine is the broken one: her `claude-code` row is written by the MCP
 * on every IDE start and is hours old, while the three the scanner writes have
 * been frozen since 07-27. Her last actual usage event was 94 days ago.
 */
const PRODUCTION = [
  ...healthy(1, 'Adam', 'after', 0.3),
  beat(2, 'Amiee Kuo', 'LAPTOP-RGE2HCSQ', 'claude-code', 0.2),
  beat(2, 'Amiee Kuo', 'LAPTOP-RGE2HCSQ', 'cursor', 11.2),
  beat(2, 'Amiee Kuo', 'LAPTOP-RGE2HCSQ', 'antigravity', 11.2),
  beat(2, 'Amiee Kuo', 'LAPTOP-RGE2HCSQ', 'opencode', 11.2),
  ...healthy(3, 'Eric', 'LAPTOP-G95HIQ3V', 0.1),
  ...healthy(4, 'Joanna', 'Fontrip-Joanna', 4.2),
  ...healthy(5, 'Michelle', 'cengmingxuandeMacBook-Pro.local', 1.2),
  ...healthy(5, 'Michelle', 'cengminuandeMBP', 0.4),
  ...healthy(6, 'Phoebe', 'phoebelin.local', 0.2),
  ...healthy(7, 'Vincent Kao', 'Vincent.local', 0.0),
  ...healthy(8, 'Vin-windows-test', 'DESKTOP-8DD75VJ', 0.0),
  ...healthy(8, 'Vin-windows-test', 'TANK', 0.5),
  ...healthy(9, '采瑤', 'LAPTOP-MBGGLV2J', 0.4),
];

describe('v1.26.102 — against the production snapshot', () => {
  const { silences } = evaluateSilence({ rows: PRODUCTION, now: NOW });

  it('finds the one machine whose scanner is dead', () => {
    assert.equal(silences.length, 1);
    assert.equal(silences[0].machine, 'LAPTOP-RGE2HCSQ');
    assert.equal(silences[0].user_name, 'Amiee Kuo');
  });

  it('names the tools that stopped, not the one still beating', () => {
    assert.equal(silences[0].stale_tools, 'antigravity,cursor,opencode');
  });

  it('reports how long it has been, from the newest of the frozen rows', () => {
    assert.equal(silences[0].stale_days, 11);
    assert.equal(
      silences[0].last_beat_at.getTime(),
      new Date(NOW.getTime() - 11.2 * 86400_000).getTime()
    );
  });

  it('stays quiet about the other ten machines', () => {
    // Without this the feature is a machine that shouts at everybody. Joanna's
    // whole computer had been off for 4.2 days and Michelle's older Mac for 1.2;
    // neither is a fault, and neither has anything the person could act on.
    assert.deepEqual(silences.filter((s) => s.machine !== 'LAPTOP-RGE2HCSQ'), []);
  });
});

describe('v1.26.102 — which frozen row the report is taken from', () => {
  const OWNER = [1, 'Someone', 'box'];

  it('takes the date and the day count from the same row: the newest frozen one', () => {
    // Every fixture above has its stale rows at one identical age, which cannot
    // tell "newest" from "oldest" apart. With 9 and 30 it can: reporting the
    // oldest would say the machine has been dead three times as long as the date
    // beside it shows.
    const { silences } = evaluateSilence({
      rows: [
        beat(...OWNER, 'claude-code', 0.1),
        beat(...OWNER, 'cursor', 30),
        beat(...OWNER, 'opencode', 9.4),
      ],
      now: NOW,
    });
    assert.equal(silences[0].stale_days, 9);
    assert.equal(
      silences[0].last_beat_at.getTime(),
      new Date(NOW.getTime() - 9.4 * 86400_000).getTime()
    );
  });

  it('rounds the day count down, so it never overstates the silence', () => {
    // 11.6 days floors to 11 and rounds to 12. Saying "12 days" beside a date
    // eleven days ago is the kind of small inconsistency that makes a reader
    // stop believing the rest of the message.
    const { silences } = evaluateSilence({
      rows: [beat(...OWNER, 'claude-code', 0.1), beat(...OWNER, 'cursor', 11.6)],
      now: NOW,
    });
    assert.equal(silences[0].stale_days, 11);
  });
});

describe('v1.26.102 — what the thresholds mean', () => {
  const OWNER = [1, 'Someone', 'box'];

  it('a machine entirely dark says nothing, however long it has been', () => {
    // This is the deliberate gap. A computer switched off for a month looks
    // identical, in this table, to one whose collector died — so the honest
    // answer is silence rather than a guess. Recorded in openspec/BACKLOG.md.
    const rows = FIVE.map((tool) => beat(...OWNER, tool, 90));
    assert.deepEqual(evaluateSilence({ rows, now: NOW }).silences, []);
  });

  it('nothing fires while the machine is between the two thresholds', () => {
    // Fresh row plus a row at 4.5 days: old enough to be odd, not old enough to
    // be a fault. The gap between FRESH_DAYS and STALE_DAYS exists so an
    // ambiguous machine produces no message at all rather than a maybe.
    const rows = [
      beat(...OWNER, 'claude-code', 0.1),
      beat(...OWNER, 'cursor', (FRESH_DAYS + STALE_DAYS) / 2),
    ];
    assert.deepEqual(evaluateSilence({ rows, now: NOW }).silences, []);
  });

  it('fires at exactly the stale threshold, not one day later', () => {
    // `>= staleDays`, not `>`. At exactly 7.0 days a strict comparison would wait
    // another whole sweep, and the boundary is the only place the two differ.
    const rows = [
      beat(...OWNER, 'claude-code', 0.1),
      beat(...OWNER, 'cursor', STALE_DAYS),
    ];
    assert.equal(evaluateSilence({ rows, now: NOW }).silences.length, 1);
  });

  it('a row just inside the threshold does not fire', () => {
    const rows = [
      beat(...OWNER, 'claude-code', 0.1),
      beat(...OWNER, 'cursor', STALE_DAYS - 0.01),
    ];
    assert.deepEqual(evaluateSilence({ rows, now: NOW }).silences, []);
  });

  it('a single-row machine cannot produce a finding', () => {
    // Nothing to disagree with. Said out loud because it is the coverage limit:
    // a machine where the scanner never ran once is invisible here.
    assert.deepEqual(evaluateSilence({ rows: [beat(...OWNER, 'claude-code', 0.1)], now: NOW }).silences, []);
  });
});

describe('v1.26.102 — it reports what is broken, not what is new', () => {
  const rows = [
    beat(1, 'Someone', 'box', 'claude-code', 0.1),
    beat(1, 'Someone', 'box', 'cursor', 30),
  ];

  it('still reports a machine that was announced days ago', () => {
    // Announce-once lives in the claim statement, not here. If this function
    // filtered too, a machine would drop out of the sighting refresh and its
    // stale_tools would freeze at whatever it was when first seen.
    const state = [{
      user_id: 1, machine: 'box', stale_tools: 'cursor',
      announced_at: new Date('2026-08-01'), resolved_at: null, broadcast_id: 7,
    }];
    assert.equal(evaluateSilence({ rows, knownState: state, now: NOW }).silences.length, 1);
  });

  it('reports the current tool list, so a widening silence updates the record', () => {
    const wider = [...rows, beat(1, 'Someone', 'box', 'opencode', 30)];
    const state = [{
      user_id: 1, machine: 'box', stale_tools: 'cursor',
      announced_at: NOW, resolved_at: null, broadcast_id: null,
    }];
    const out = evaluateSilence({ rows: wider, knownState: state, now: NOW });
    assert.equal(out.silences[0].stale_tools, 'cursor,opencode');
  });

  it('the tool list does not depend on the order the database returned', () => {
    // stale_tools is compared as a string to decide "same silence". Row order is
    // not part of the finding, so it must not change the string.
    assert.equal(toolsFingerprint(['cursor', 'antigravity']), toolsFingerprint(['antigravity', 'cursor']));
  });
});

describe('v1.26.102 — recovery', () => {
  const repaired = FIVE.map((tool) => beat(1, 'Someone', 'box', tool, 0.1));

  it('closes an announced finding once every tool is beating again', () => {
    const state = [{
      user_id: 1, machine: 'box', stale_tools: 'cursor',
      announced_at: NOW, resolved_at: null, broadcast_id: 42,
    }];
    assert.deepEqual(evaluateSilence({ rows: repaired, knownState: state, now: NOW }).resolved,
      [{ user_id: 1, machine: 'box', broadcast_id: 42 }]);
  });

  it('carries the broadcast to end, so the job need not look it up again', () => {
    // Re-reading it after marking the row resolved would read the row this sweep
    // just changed; carrying it forward from the state already loaded cannot.
    const state = [{
      user_id: 1, machine: 'box', stale_tools: 'cursor',
      announced_at: NOW, resolved_at: null, broadcast_id: null,
    }];
    assert.equal(evaluateSilence({ rows: repaired, knownState: state, now: NOW }).resolved[0].broadcast_id, null);
  });

  it('does not close it again once closed', () => {
    // A second resolve would end a broadcast that a later failure had opened.
    const state = [{
      user_id: 1, machine: 'box', stale_tools: 'cursor',
      announced_at: NOW, resolved_at: NOW, broadcast_id: 42,
    }];
    assert.deepEqual(evaluateSilence({ rows: repaired, knownState: state, now: NOW }).resolved, []);
  });

  it('drops a sighting that healed before anybody was told', () => {
    // Its first_seen_at must not survive: the next break would inherit an old
    // clock and skip the waiting period this machine was never observed through.
    const state = [{
      user_id: 1, machine: 'box', stale_tools: 'cursor',
      announced_at: null, resolved_at: null, broadcast_id: null,
    }];
    const out = evaluateSilence({ rows: repaired, knownState: state, now: NOW });
    assert.deepEqual(out.cleared, [{ user_id: 1, machine: 'box' }]);
    assert.deepEqual(out.resolved, [], 'an unannounced sighting has no notice to end');
  });

  it('a machine that vanished from the table is left alone', () => {
    // Absence is not recovery. Marking it resolved would end the notice for a
    // machine nobody has heard from at all.
    const state = [{
      user_id: 1, machine: 'box', stale_tools: 'cursor',
      announced_at: NOW, resolved_at: null, broadcast_id: 42,
    }];
    const out = evaluateSilence({ rows: [], knownState: state, now: NOW });
    assert.deepEqual(out.resolved, []);
    assert.deepEqual(out.cleared, []);
    assert.deepEqual(out.silences, []);
  });
});

describe('v1.26.102 — rubbish input', () => {
  it('an unreadable timestamp does not vouch for the machine', () => {
    // Treating an unparseable date as age 0 would make it the "something is
    // still alive" evidence, and a broken row would certify a dead machine.
    const rows = [
      { user_id: 1, user_name: 'x', machine: 'box', tool: 'claude-code', last_reported_at: 'not-a-date' },
      beat(1, 'x', 'box', 'cursor', 30),
    ];
    assert.deepEqual(evaluateSilence({ rows, now: NOW }).silences, []);
  });

  it('never throws on missing fields', () => {
    for (const row of [null, {}, { user_id: 1 }, { machine: 'box' }, { user_id: '1', machine: 'box' }]) {
      assert.doesNotThrow(() => evaluateSilence({ rows: [row], now: NOW }));
    }
  });
});
