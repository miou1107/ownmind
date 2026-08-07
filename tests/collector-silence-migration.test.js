// tests/collector-silence-migration.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as job from '../src/jobs/collector-silence-alerts.js';

describe('023_collector_silence_alert_state migration', () => {
  const sql = readFileSync(new URL('../db/023_collector_silence_alert_state.sql', import.meta.url), 'utf8');

  it('creates the table idempotently', () => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS collector_silence_alert_state/);
  });

  it('keys a silence by user and machine, not by tool', () => {
    // One dead schedule freezes every tool at once. Keying on the tool would
    // announce one broken machine four times.
    assert.match(sql, /UNIQUE\s*\(\s*user_id\s*,\s*machine\s*\)/);
  });

  it('cascades when a user is deleted', () => {
    assert.match(sql, /REFERENCES\s+users\s*\(\s*id\s*\)\s+ON DELETE CASCADE/);
  });

  it('carries every column the job reads or writes', () => {
    for (const col of ['stale_tools', 'last_beat_at', 'first_seen_at',
                       'announced_at', 'resolved_at', 'broadcast_id']) {
      assert.match(sql, new RegExp(`\\b${col}\\b`), `${col} missing`);
    }
  });

  it('first_seen_at defaults to now, because the claim compares against it', () => {
    // It is the confirmation window's only input. A column that defaulted to
    // NULL would make `first_seen_at <= NOW() - INTERVAL` never true, and nothing
    // would ever be announced — silently, with every test above still green.
    assert.match(sql, /first_seen_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT NOW\(\)/);
  });

  it('announced_at is nullable, because a sighting is recorded before it is announced', () => {
    assert.doesNotMatch(sql, /announced_at\s+TIMESTAMPTZ\s+NOT NULL/);
  });

  it('lets an admin delete a broadcast without erasing the record of it', () => {
    // ON DELETE CASCADE here would take the whole state row with the broadcast,
    // and the next sweep would announce the same machine again.
    assert.match(sql, /broadcast_id[^\n]*REFERENCES\s+broadcast_messages\s*\(\s*id\s*\)\s+ON DELETE SET NULL/);
  });

  it('matches the type of the column it points at', () => {
    // broadcast_messages.id is INTEGER. A mismatch here is the kind of thing a
    // project with no type checking discovers on the production migration.
    assert.match(sql, /broadcast_id\s+INTEGER\b/);
  });
});

describe('the job is wired into server startup', () => {
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

  it('exports both the sweep and the schedule under the names index.js uses', () => {
    // Nothing type-checks this repo, so a renamed export packs fine and throws
    // on the line that calls it — at server boot, which is the worst place.
    assert.equal(typeof job.runCollectorSilenceAlerts, 'function');
    assert.equal(typeof job.startCollectorSilenceJob, 'function');
    assert.match(index, /runCollectorSilenceAlerts\s*,/);
    assert.match(index, /startCollectorSilenceJob\s*,?\s*\n?\s*\}?\s*from/s);
  });

  it('runs a sweep at boot as well as on the schedule', () => {
    // Without the boot sweep, the machines already silent when this release ships
    // wait until 04:00 the next morning to surface — and the boot sweep is the
    // only thing that makes a deploy show its effect.
    assert.match(index, /startCollectorSilenceJob\(\)/);
    assert.match(index, /runCollectorSilenceAlerts\(\)\.catch/);
  });

  it('never lets a failed sweep take the server down with it', () => {
    assert.match(index, /runCollectorSilenceAlerts\(\)\.catch\(\(err\)\s*=>/);
  });
});
