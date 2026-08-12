// v1.26.142 — the one check that asks whether the data is arriving, on the one path that
// runs.
//
// `usage_roundtrip` scans, reads back from the server, and compares the two per tool. It is
// the only check that can answer "why does this account have no rows for that tool"; the
// other fourteen ask whether things are installed.
//
// v1.26.81 took it out of the `--quick` set, reasoning that scanning every local database
// once a day in the background is too much for a check the scanner's own schedule already
// covers. That reasoning holds. What was not measured is that `--quick` is the auto-update
// path — so for anyone who does not re-run the installer by hand, it is the only path, and
// "not every day" became "not ever". One member's machine has uploaded fourteen checks a
// day for weeks and has never once run the fifteenth.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tempDir } from './helpers/temp-dir.js';

const require = createRequire(import.meta.url);
const selfCheck = require('../scripts/install-helpers/self-check.cjs');
const { roundtripDue, stampRoundtrip, ROUNDTRIP_INTERVAL_DAYS, checkNamesFor } = selfCheck;

let ROOT;
let marker;
const NOW = new Date('2026-08-11T09:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);

beforeEach(async () => {
  ROOT = await tempDir('ownmind-roundtrip-');
  marker = path.join(ROOT, '.last-usage-roundtrip');
});
afterEach(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
});

describe('the weekly gate', () => {
  it('is due when the marker has never been written', () => {
    // The state every machine is in the first time it runs this version — including the
    // machines this exists for.
    assert.equal(roundtripDue(marker, NOW), true);
  });

  it('is not due the day after it ran', () => {
    fs.writeFileSync(marker, daysAgo(1));
    assert.equal(roundtripDue(marker, NOW), false);
  });

  it('is not due one day short of the interval', () => {
    fs.writeFileSync(marker, daysAgo(ROUNDTRIP_INTERVAL_DAYS - 1));
    assert.equal(roundtripDue(marker, NOW), false);
  });

  it('is due exactly on the interval', () => {
    fs.writeFileSync(marker, daysAgo(ROUNDTRIP_INTERVAL_DAYS));
    assert.equal(roundtripDue(marker, NOW), true);
  });

  it('is due long after', () => {
    fs.writeFileSync(marker, daysAgo(90));
    assert.equal(roundtripDue(marker, NOW), true);
  });
});

describe('the gate fails towards collecting', () => {
  // Every failure to read has to answer "run it". The machines that cannot be reasoned
  // about from the server are the entire point of the check, and a throttle that fails
  // closed would silence exactly the population it exists to serve.

  it('runs when the marker holds something that is not a date', () => {
    fs.writeFileSync(marker, 'not-a-date');
    assert.equal(roundtripDue(marker, NOW), true);
  });

  it('runs when the marker is empty', () => {
    fs.writeFileSync(marker, '   \n');
    assert.equal(roundtripDue(marker, NOW), true);
  });

  it('runs when the marker is a directory it cannot read', () => {
    fs.mkdirSync(marker);
    assert.equal(roundtripDue(marker, NOW), true);
  });

  it('runs when the clock has moved backwards', () => {
    // A machine whose date is wrong is a machine worth hearing from, and a future stamp
    // would otherwise suppress the check until the calendar caught up.
    fs.writeFileSync(marker, '2027-01-01');
    assert.equal(roundtripDue(marker, NOW), true);
  });
});

describe('stamping', () => {
  it('records a date the gate then reads as not due', () => {
    stampRoundtrip(marker, NOW);
    assert.equal(fs.readFileSync(marker, 'utf8'), '2026-08-11');
    assert.equal(roundtripDue(marker, NOW), false);
  });

  it('does not throw when the marker cannot be written', () => {
    // A read-only ~/.ownmind must not fail a check that has already run. The only cost of
    // not recording it is running again next time, which is the safe direction.
    const unwritable = path.join(ROOT, 'no-such-dir', 'marker');
    assert.doesNotThrow(() => stampRoundtrip(unwritable, NOW));
  });
});

describe('the declared check set follows the gate', () => {
  // checkNamesFor is the answer to "which checks run" and exists so the quick/full split
  // can be asserted without credentials, a server and a scan. A hardcoded list here would
  // go on claiming the round-trip never runs on a quick pass the moment it starts to.

  it('names every check on a full run', async () => {
    const names = await checkNamesFor({ quick: false });
    assert.ok(names.includes('usage_roundtrip'));
    assert.ok(names.includes('memory_load'));
  });

  it('includes the round-trip on a quick run when it is due', async () => {
    // No marker: the state every machine is in the first time it runs this version.
    const names = await checkNamesFor({ quick: true, markerPath: marker });
    assert.ok(names.includes('usage_roundtrip'),
      'a quick run must stop meaning "never"');
  });

  it('leaves it out of a quick run inside the interval', async () => {
    fs.writeFileSync(marker, daysAgo(1));
    const names = await checkNamesFor({ quick: true, markerPath: marker });
    assert.equal(names.includes('usage_roundtrip'), false,
      'the daily cost v1.26.81 objected to must not come back');
    assert.ok(names.includes('memory_load'), 'the rest of the quick set is unaffected');
  });

  it('brings it back once the interval has passed', async () => {
    fs.writeFileSync(marker, daysAgo(ROUNDTRIP_INTERVAL_DAYS));
    const names = await checkNamesFor({ quick: true, markerPath: marker });
    assert.ok(names.includes('usage_roundtrip'));
  });
});
