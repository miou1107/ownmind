/**
 * lastLoadState() decides what the team page's "最近一次載入記憶" cell shows for one member:
 * which light, which words, and the second muted line. Pure function, so the colour rules
 * are tested here instead of through a rendered page.
 *
 * `now` is built from local-time parts because the cell shows the viewer's local time.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lastLoadState } from '../client/src/pages/Admin/last-load.js';

const NOW = new Date(2026, 9, 23, 14, 30); // 10/23 14:30 local
const at = (m, d, h, min) => new Date(2026, m - 1, d, h, min).toISOString();

const row = (over = {}) => ({
  deactivated_at: null,
  last_memory_load_at: null,
  last_machine: null,
  first_install_at: null,
  last_install_error_at: null,
  ...over,
});

describe('lastLoadState — green', () => {
  it('shows 今天 time and the machine when the last load was today', () => {
    const s = lastLoadState(row({ last_memory_load_at: at(10, 23, 9, 12), last_machine: 'iMac.local', first_install_at: at(10, 20, 8, 0) }), NOW);
    assert.equal(s.light, 'green');
    assert.equal(s.labelKey, 'team.load.today');
    assert.deepEqual(s.labelParams, { time: '09:12' });
    assert.deepEqual(s.detail, { text: 'iMac.local' });
    assert.equal(s.tipKey, 'team.load.tip.green');
  });

  it('shows 昨天 time when the last load was yesterday', () => {
    const s = lastLoadState(row({ last_memory_load_at: at(10, 22, 23, 5), last_machine: 'm' }), NOW);
    assert.equal(s.labelKey, 'team.load.yesterday');
    assert.deepEqual(s.labelParams, { time: '23:05' });
  });

  it('shows M/D HH:MM when the last load was earlier than yesterday', () => {
    const s = lastLoadState(row({ last_memory_load_at: at(10, 9, 7, 3), last_machine: 'm' }), NOW);
    assert.equal(s.light, 'green');
    assert.equal(s.labelKey, 'team.load.dated');
    assert.deepEqual(s.labelParams, { date: '10/9', time: '07:03' });
  });

  it('treats midnight as the day boundary (00:01 today is today, 23:59 the day before is yesterday)', () => {
    assert.equal(lastLoadState(row({ last_memory_load_at: at(10, 23, 0, 1) }), NOW).labelKey, 'team.load.today');
    assert.equal(lastLoadState(row({ last_memory_load_at: at(10, 22, 23, 59) }), NOW).labelKey, 'team.load.yesterday');
  });

  it('has no second line when the machine is unknown', () => {
    const s = lastLoadState(row({ last_memory_load_at: at(10, 23, 9, 12) }), NOW);
    assert.equal(s.light, 'green');
    assert.equal(s.detail, null);
  });

  it('stays green when the install error is older than the last load', () => {
    const s = lastLoadState(row({
      last_memory_load_at: at(10, 23, 9, 12), last_install_error_at: at(10, 22, 15, 40),
      first_install_at: at(10, 22, 15, 0), last_machine: 'iMac.local',
    }), NOW);
    assert.equal(s.light, 'green');
  });
});

describe('lastLoadState — yellow', () => {
  it('installed but never loaded: pill text and 機器，M/D 裝的', () => {
    const s = lastLoadState(row({ first_install_at: at(10, 22, 11, 0), last_machine: 'DESKTOP-UOTCNN6' }), NOW);
    assert.equal(s.light, 'yellow');
    assert.equal(s.labelKey, 'team.load.never');
    assert.equal(s.pill, true);
    assert.deepEqual(s.detail, { key: 'team.load.never_detail', params: { machine: 'DESKTOP-UOTCNN6', date: '10/22' } });
    assert.equal(s.tipKey, 'team.load.tip.yellow');
  });

  it('drops the machine from the second line when it was not reported', () => {
    const s = lastLoadState(row({ first_install_at: at(10, 22, 11, 0) }), NOW);
    assert.deepEqual(s.detail, { key: 'team.load.never_detail_nomachine', params: { date: '10/22' } });
  });
});

describe('lastLoadState — red', () => {
  it('install error and never loaded: red with the error time', () => {
    const s = lastLoadState(row({ first_install_at: at(10, 22, 15, 0), last_install_error_at: at(10, 22, 15, 40), last_machine: 'm' }), NOW);
    assert.equal(s.light, 'red');
    assert.equal(s.labelKey, 'team.load.error');
    assert.equal(s.pill, true);
    assert.deepEqual(s.detail, { key: 'team.load.error_detail', params: { time: '10/22 15:40' } });
    assert.equal(s.tipKey, 'team.load.tip.red');
  });

  it('install error newer than the last load: red', () => {
    const s = lastLoadState(row({ last_memory_load_at: at(10, 20, 9, 0), last_install_error_at: at(10, 22, 15, 40), first_install_at: at(10, 1, 0, 0) }), NOW);
    assert.equal(s.light, 'red');
  });

  it('an error with no install row at all is still red', () => {
    const s = lastLoadState(row({ last_install_error_at: at(10, 22, 15, 40) }), NOW);
    assert.equal(s.light, 'red');
  });
});

describe('lastLoadState — none and deactivated', () => {
  it('no install and no load: muted 還沒安裝, no dot (not a fourth light)', () => {
    const s = lastLoadState(row(), NOW);
    assert.equal(s.light, 'none');
    assert.equal(s.labelKey, 'team.load.not_installed');
    assert.equal(s.detail, null);
    assert.equal(s.tipKey, null);
  });

  it('an install that died at its beacon (no finished install, no error) is none, not yellow', () => {
    // The server leaves first_install_at null until a self-check has reported.
    const s = lastLoadState(row({ last_machine: 'M5' }), NOW);
    assert.equal(s.light, 'none');
    assert.equal(s.labelKey, 'team.load.not_installed');
  });

  it('an install that died with an error report and no finished install is red', () => {
    const s = lastLoadState(row({ last_machine: 'M9', last_install_error_at: at(10, 22, 15, 40) }), NOW);
    assert.equal(s.light, 'red');
  });

  it('a deactivated member gets the muted deactivated treatment, whatever the data says', () => {
    const s = lastLoadState(row({ deactivated_at: at(10, 20, 0, 0), last_memory_load_at: at(10, 23, 9, 12) }), NOW);
    assert.equal(s.light, 'none');
    assert.equal(s.deactivated, true);
  });

  it('ignores timestamps that do not parse instead of printing NaN', () => {
    const s = lastLoadState(row({ last_memory_load_at: 'garbage', first_install_at: at(10, 22, 11, 0) }), NOW);
    assert.equal(s.light, 'yellow');
  });
});
