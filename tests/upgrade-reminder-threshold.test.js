// v1.26.129 — the upgrade reminder only fires for a machine the automation is not reaching.
//
// It used to target `${SERVER_VERSION}-prev`: every client not on the exact newest build.
// This repo ships several versions a day, and the reminder is mandatory severity — it takes
// over the AI's first sentence. So nearly every user was told, nearly every day, to run an
// upgrade that the daily background updater had already run.
//
// A notice that fires when nothing is wrong is a notice people learn to skip, which is how a
// real one gets missed later.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reminderThreshold, LAG_PATCHES } from '../src/jobs/nightly-upgrade-reminder.js';
import { isHigher } from '../src/utils/semver.js';

/**
 * The real filter, not a copy of it. An earlier draft reimplemented the semver comparison
 * here; it agreed on every case, which is precisely the situation where both ends of an
 * interface are faked and the test only proves the two fakes agree.
 */
function reminded(clientVersion, serverVersion) {
  return !isHigher(clientVersion, reminderThreshold(serverVersion));
}

describe('who gets the upgrade reminder', () => {
  it('a user one version behind is left alone', () => {
    // The old behaviour, and the whole reason this changed: shipping several versions a day
    // meant this user was reminded daily about an update that lands on its own.
    assert.equal(reminded('1.26.128', '1.26.129'), false);
  });

  it('a user a few versions behind is left alone', () => {
    assert.equal(reminded('1.26.125', '1.26.129'), false);
  });

  it('a user far enough behind that the automation is clearly stuck is reminded', () => {
    assert.equal(reminded('1.26.100', '1.26.129'), true);
  });

  it('the boundary is where LAG_PATCHES says it is', () => {
    // Pinned so a change to the constant is a decision rather than a drift.
    const server = '1.26.129';
    assert.equal(reminded(`1.26.${129 - LAG_PATCHES}`, server), false);
    assert.equal(reminded(`1.26.${129 - LAG_PATCHES - 1}`, server), true);
  });

  it('a user on the current version is left alone', () => {
    assert.equal(reminded('1.26.129', '1.26.129'), false);
  });

  it('an early patch of a new minor reminds the previous minor, not everyone', () => {
    // patch 3 minus a lag of 10 would go negative. Falling back to .0 of the new minor means
    // the people who are actually stuck — still on the old minor — are the ones told.
    assert.equal(reminderThreshold('1.27.3'), '1.27.0-prev');
    assert.equal(reminded('1.26.129', '1.27.3'), true);
    assert.equal(reminded('1.27.1', '1.27.3'), false);
  });
});

describe('what the reminder says', () => {
  it('describes a broken updater, not a new release', async () => {
    // The user cannot act on "there is a new version" — that is the automation's job. What
    // they can act on is "your updates are not landing".
    const src = await import('node:fs').then((fs) => fs.readFileSync(
      new URL('../src/jobs/nightly-upgrade-reminder.js', import.meta.url), 'utf8',
    ));
    assert.match(src, /自動更新好像沒在運作/);
    assert.match(src, /回報 ownmind bug/, 'the message has to offer a way out when a retry fails');
    assert.doesNotMatch(src, /新版包含/, 'the release-note framing belongs to the old behaviour');
  });
});

describe('superseded reminders are retired', () => {
  // These rows have never carried an ends_at and the admin API refuses to revoke is_auto
  // broadcasts, so without this the threshold change is invisible: a user five versions
  // behind still matches yesterday's row, with the old "有新版本" wording, and the hook shows
  // three at once — the new message with two stale ones stacked under it.
  it('ends the auto reminders this run supersedes, and nothing a human wrote', async () => {
    const { ensureUpgradeReminder } = await import('../src/jobs/nightly-upgrade-reminder.js');
    const seen = [];
    const query = async (sql, params) => {
      seen.push({ sql, params });
      if (/role = 'super_admin'/.test(sql)) return { rowCount: 1, rows: [{ id: 1 }] };
      if (/UPDATE broadcast_messages/.test(sql)) return { rowCount: 3, rows: [] };
      if (/SELECT id FROM broadcast_messages/.test(sql)) return { rowCount: 1, rows: [{ id: 9 }] };
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    };
    await ensureUpgradeReminder({ query, serverVersion: '1.26.129' });

    const update = seen.find((c) => /UPDATE broadcast_messages/.test(c.sql));
    assert.ok(update, 'the job never retired the reminders it supersedes');
    assert.match(update.sql, /is_auto = TRUE/, 'a hand-written broadcast must not be touched');
    assert.match(update.sql, /type = 'upgrade_reminder'/);
    assert.match(update.sql, /max_version IS DISTINCT FROM/, 'this run\'s own row must survive');
    assert.deepEqual(update.params, ['1.26.119-prev']);
  });

  it('retires before checking whether to insert', async () => {
    // The existence check looks for an active row at this exact max_version. Running the
    // retirement after it would be harmless today but reverses the intent the moment the
    // threshold and an existing row coincide.
    const { ensureUpgradeReminder } = await import('../src/jobs/nightly-upgrade-reminder.js');
    const order = [];
    const query = async (sql) => {
      if (/role = 'super_admin'/.test(sql)) return { rowCount: 1, rows: [{ id: 1 }] };
      if (/UPDATE broadcast_messages/.test(sql)) { order.push('retire'); return { rowCount: 1, rows: [] }; }
      if (/SELECT id FROM broadcast_messages/.test(sql)) { order.push('check'); return { rowCount: 1, rows: [{ id: 9 }] }; }
      throw new Error('unexpected');
    };
    await ensureUpgradeReminder({ query, serverVersion: '1.26.129' });
    assert.deepEqual(order, ['retire', 'check']);
  });
});
