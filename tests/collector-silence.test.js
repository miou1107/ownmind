import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateSilence, toolsFingerprint, FRESH_DAYS, STALE_DAYS,
} from '../src/lib/collector-silence.js';

/**
 * v1.26.99 — a dead usage collector is detected from disagreement inside one
 * machine, not from absolute silence.
 *
 * The thresholds were chosen against a real snapshot of `collector_heartbeat`
 * (production, 2026-08-07), which is reproduced below rather than described. The
 * point of keeping it is the negative half: ten healthy machines that must stay
 * quiet. A detector that fires on the broken one is easy; one that fires on
 * nobody else is the thing worth pinning.
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

describe('v1.26.99 — against the production snapshot', () => {
  const { newSilences } = evaluateSilence({ rows: PRODUCTION, now: NOW });

  it('finds the one machine whose scanner is dead', () => {
    assert.equal(newSilences.length, 1);
    assert.equal(newSilences[0].machine, 'LAPTOP-RGE2HCSQ');
    assert.equal(newSilences[0].user_name, 'Amiee Kuo');
  });

  it('names the tools that stopped, not the one still beating', () => {
    assert.equal(newSilences[0].stale_tools, 'antigravity,cursor,opencode');
    assert.equal(newSilences[0].live_tools, 'claude-code');
  });

  it('reports how long it has been, from the newest of the frozen rows', () => {
    // 11.2 days, floored. The date shown to the reader comes from the same row,
    // so "last seen 07-27" and "11 days" cannot contradict each other.
    assert.equal(newSilences[0].stale_days, 11);
    assert.equal(
      newSilences[0].last_beat_at.getTime(),
      new Date(NOW.getTime() - 11.2 * 86400_000).getTime()
    );
  });

  it('stays quiet about the other ten machines', () => {
    // Without this the feature is a machine that shouts at everybody. Joanna's
    // whole computer had been off for 4.2 days and Michelle's older Mac for 1.2;
    // neither is a fault, and neither has anything the person could act on.
    const others = newSilences.filter((s) => s.machine !== 'LAPTOP-RGE2HCSQ');
    assert.deepEqual(others, []);
  });
});

describe('v1.26.99 — what the thresholds mean', () => {
  const OWNER = [1, 'Someone', 'box'];

  it('a machine entirely dark says nothing, however long it has been', () => {
    // This is the deliberate gap. A computer switched off for a month looks
    // identical, in this table, to one whose collector died — so the honest
    // answer is silence rather than a guess. Recorded in openspec/BACKLOG.md.
    const rows = FIVE.map((tool) => beat(...OWNER, tool, 90));
    assert.deepEqual(evaluateSilence({ rows, now: NOW }).newSilences, []);
  });

  it('nothing fires while the machine is between the two thresholds', () => {
    // Fresh row plus a row at 4 days: old enough to be odd, not old enough to be
    // a fault. The gap between FRESH_DAYS and STALE_DAYS exists so an ambiguous
    // machine produces no message at all rather than a maybe.
    const rows = [
      beat(...OWNER, 'claude-code', 0.1),
      beat(...OWNER, 'cursor', (FRESH_DAYS + STALE_DAYS) / 2),
    ];
    assert.deepEqual(evaluateSilence({ rows, now: NOW }).newSilences, []);
  });

  it('fires as soon as one row crosses the stale threshold', () => {
    const rows = [
      beat(...OWNER, 'claude-code', 0.1),
      beat(...OWNER, 'cursor', STALE_DAYS + 0.01),
    ];
    assert.equal(evaluateSilence({ rows, now: NOW }).newSilences.length, 1);
  });

  it('a single-row machine cannot produce a finding', () => {
    // Nothing to disagree with. Said out loud because it is the coverage limit:
    // a machine where the scanner never ran once is invisible here.
    const rows = [beat(...OWNER, 'claude-code', 0.1)];
    assert.deepEqual(evaluateSilence({ rows, now: NOW }).newSilences, []);
  });
});

describe('v1.26.99 — running it twice', () => {
  const rows = [
    beat(1, 'Someone', 'box', 'claude-code', 0.1),
    beat(1, 'Someone', 'box', 'cursor', 30),
  ];

  it('says nothing the second time, given the state the first run wrote', () => {
    // The whole point of the state table. Without this the person is told the
    // same thing every morning for as long as the machine stays broken.
    const first = evaluateSilence({ rows, now: NOW });
    assert.equal(first.newSilences.length, 1);

    const state = [{
      user_id: 1, machine: 'box',
      stale_tools: first.newSilences[0].stale_tools,
      announced_at: NOW, resolved_at: null,
    }];
    const second = evaluateSilence({ rows, knownState: state, now: NOW });
    assert.deepEqual(second.newSilences, []);
    assert.deepEqual(second.detailChanges, []);
  });

  it('updates the record, silently, when the silence widens', () => {
    const state = [{
      user_id: 1, machine: 'box', stale_tools: 'cursor',
      announced_at: NOW, resolved_at: null,
    }];
    const wider = [...rows, beat(1, 'Someone', 'box', 'opencode', 30)];
    const out = evaluateSilence({ rows: wider, knownState: state, now: NOW });
    assert.deepEqual(out.newSilences, []);
    assert.equal(out.detailChanges.length, 1);
    assert.equal(out.detailChanges[0].stale_tools, 'cursor,opencode');
  });

  it('the tool list does not depend on the order the database returned', () => {
    // stale_tools is compared as a string to decide "same silence". Row order is
    // not part of the finding, so it must not change the string.
    assert.equal(toolsFingerprint(['cursor', 'antigravity']), toolsFingerprint(['antigravity', 'cursor']));
  });
});

describe('v1.26.99 — recovery', () => {
  it('closes the finding once every tool is beating again', () => {
    const rows = FIVE.map((tool) => beat(1, 'Someone', 'box', tool, 0.1));
    const state = [{
      user_id: 1, machine: 'box', stale_tools: 'cursor',
      announced_at: NOW, resolved_at: null,
    }];
    const out = evaluateSilence({ rows, knownState: state, now: NOW });
    assert.deepEqual(out.resolved, [{ user_id: 1, machine: 'box' }]);
  });

  it('does not close it again once closed', () => {
    // A second resolve would end a broadcast that a later failure had opened.
    const rows = FIVE.map((tool) => beat(1, 'Someone', 'box', tool, 0.1));
    const state = [{
      user_id: 1, machine: 'box', stale_tools: 'cursor',
      announced_at: NOW, resolved_at: NOW,
    }];
    assert.deepEqual(evaluateSilence({ rows, knownState: state, now: NOW }).resolved, []);
  });

  it('announces again if the same machine breaks a second time', () => {
    const rows = [
      beat(1, 'Someone', 'box', 'claude-code', 0.1),
      beat(1, 'Someone', 'box', 'cursor', 30),
    ];
    const state = [{
      user_id: 1, machine: 'box', stale_tools: 'cursor',
      announced_at: new Date('2026-01-01'), resolved_at: new Date('2026-02-01'),
    }];
    assert.equal(evaluateSilence({ rows, knownState: state, now: NOW }).newSilences.length, 1);
  });

  it('a machine that vanished from the table is left alone', () => {
    // Absence is not recovery. Marking it resolved would end the notice for a
    // machine nobody has heard from at all.
    const state = [{
      user_id: 1, machine: 'box', stale_tools: 'cursor',
      announced_at: NOW, resolved_at: null,
    }];
    const out = evaluateSilence({ rows: [], knownState: state, now: NOW });
    assert.deepEqual(out.resolved, []);
    assert.deepEqual(out.newSilences, []);
  });
});

describe('v1.26.99 — rubbish input', () => {
  it('an unreadable timestamp does not vouch for the machine', () => {
    // Treating an unparseable date as age 0 would make it the "something is
    // still alive" evidence, and a broken row would certify a dead machine.
    const rows = [
      { user_id: 1, user_name: 'x', machine: 'box', tool: 'claude-code', last_reported_at: 'not-a-date' },
      beat(1, 'x', 'box', 'cursor', 30),
    ];
    assert.deepEqual(evaluateSilence({ rows, now: NOW }).newSilences, []);
  });

  it('never throws on missing fields', () => {
    for (const row of [null, {}, { user_id: 1 }, { machine: 'box' }, { user_id: '1', machine: 'box' }]) {
      assert.doesNotThrow(() => evaluateSilence({ rows: [row], now: NOW }));
    }
  });
});
