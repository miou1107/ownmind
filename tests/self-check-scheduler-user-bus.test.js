// v1.32.12 — a self-check that cannot see the timer must not report it as broken, and
// must not report it as healthy either.
//
// Traced from production on 2026-10-12, bot.kkvin.com (Ubuntu 24.04, headless VPS). The
// daily report carried `scheduler` as a failure:
//
//   systemctl failed: Command failed: systemctl --user is-active ownmind-usage-scanner.timer
//   Failed to connect to bus: No medium found
//
// The timer was fine. `systemctl --user list-timers` showed it active, last run 24 minutes
// earlier, exit 0, and the scanner log showed usage going to the server the day before.
// What was missing was the bus, not the timer: the self-check runs inside a Claude Code
// session that cron starts, and a cron process inherits neither DBUS_SESSION_BUS_ADDRESS
// nor XDG_RUNTIME_DIR. Every `systemctl --user` call in that context fails the same way
// whatever state the timer is in.
//
// `ensure-scanner-schedule.sh` has guarded this since v1.26.79, and its comment names this
// exact caller: "A caller without that environment — a cron job, say — would fail this
// probe on a machine where the timer works fine". The repair skipped quietly; the check it
// is paired with went on crying wolf.
//
// Why warn and not pass. Only `fail` raises an alert (src/lib/install-check-alerts.js), so
// warn is enough to stop the daily false alarm. pass would additionally claim the timer is
// healthy, and nothing else would notice if it were not: `usage_roundtrip` runs a scan of
// its own before asking the server, so it reports green on a machine whose timer has been
// dead for months. That status is the decision this file exists to pin — an equality
// assertion, not `notEqual(…, 'fail')`, which a silent change to pass would survive.
//
// The stub stands in for the OS, not for our own code: a real `systemctl` on PATH whose
// answers the test controls through files, and the real check function calling it.
// Exercised on any platform because the Linux branch is exported separately — a Mac cannot
// otherwise reach it, and this defect lives on the machines a Mac never runs on.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selfCheck = require(path.join(repoRoot, 'scripts/install-helpers/self-check.cjs'));

let sandbox;
let state;
let binWithSystemctl;
let binWithout;
let origPath;

// `bus`, `active` and `hang` are separate files on purpose. One flag could not represent
// "the bus is there and the timer is dead", which is the state that still has to be loud.
const STATE_FILES = ['bus', 'active', 'hang', 'systemctl.calls'];

before(() => {
  sandbox = tempDir('ownmind-sched-bus-');
  state = path.join(sandbox, 'state');
  binWithSystemctl = path.join(sandbox, 'bin');
  binWithout = path.join(sandbox, 'empty-bin');
  for (const d of [state, binWithSystemctl, binWithout]) fs.mkdirSync(d, { recursive: true });

  // A systemctl that behaves the way the real one does: `is-active` exits 3 and prints the
  // state word for a dead timer, and with no bus every subcommand fails the same way.
  const stub = path.join(binWithSystemctl, 'systemctl');
  fs.writeFileSync(stub, `#!/bin/sh
printf '%s\\n' "$*" >> "${state}/systemctl.calls"
if [ ! -f "${state}/bus" ]; then
  case "$*" in
    *show-environment*)
      # Trapping TERM and exiting non-zero is what a wrapper script does, and it is the
      # case that tells the two readings apart: the exit status looks exactly like the
      # no-bus exit status, and only the killed flag says the process was cut short.
      if [ -f "${state}/hang" ]; then
        trap 'exit 1' TERM
        /bin/sleep 30 &
        wait
        exit 1
      fi
      ;;
  esac
  echo "Failed to connect to bus: No medium found" >&2
  exit 1
fi
for a in "$@"; do
  case "$a" in
    show-environment) exit 0 ;;
    is-active)        if [ -f "${state}/active" ]; then echo active; exit 0; fi
                      echo inactive; exit 3 ;;
  esac
done
exit 0
`);
  fs.chmodSync(stub, 0o755);

  origPath = process.env.PATH;
});

after(() => {
  process.env.PATH = origPath;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of STATE_FILES) fs.rmSync(path.join(state, f), { force: true });
  process.env.PATH = binWithSystemctl;
});

const setBus = () => fs.writeFileSync(path.join(state, 'bus'), '');
const setActive = () => fs.writeFileSync(path.join(state, 'active'), '');
const setHang = () => fs.writeFileSync(path.join(state, 'hang'), '');
const calls = () => {
  const p = path.join(state, 'systemctl.calls');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

describe('v1.32.12 — checkSchedulerLinux when it cannot see the timer', () => {
  it('is exported so the Linux branch can be asserted from any platform', () => {
    assert.equal(typeof selfCheck.checkSchedulerLinux, 'function',
      'checkSchedulerLinux must be exported; the Linux branch is unreachable on a Mac otherwise');
  });

  it('no user bus: warn, not fail and not pass', async () => {
    const r = await selfCheck.checkSchedulerLinux();
    assert.equal(r.name, 'scheduler');
    assert.equal(r.status, 'warn',
      'fail is the daily false alarm this fixes; pass would claim a healthy timer nobody could see');
    assert.equal(r.detail, selfCheck.NO_USER_BUS_DETAIL,
      'the detail has to be the shared constant, so a log line cannot claim a check that never ran');
  });

  it('no user bus: the check actually asked whether a bus was there', async () => {
    await selfCheck.checkSchedulerLinux();
    assert.match(calls(), /show-environment/,
      'the skip must be decided by probing for the bus, not by matching the error text');
  });

  it('no systemctl at all: warn, and says nothing is scheduling the scanner', async () => {
    process.env.PATH = binWithout;
    const r = await selfCheck.checkSchedulerLinux();
    assert.equal(r.status, 'warn');
    assert.equal(r.detail, selfCheck.NO_SYSTEMCTL_DETAIL,
      'a box with no systemd has no timer at all; saying "no bus" there describes the wrong thing');
    assert.doesNotMatch(r.fix, /systemctl/,
      'telling a machine without systemctl to run systemctl is not a repair');
  });

  it('the bus probe times out: warn, and says the question went unanswered', async () => {
    setHang();
    const r = await selfCheck.checkSchedulerLinux();
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /could not ask/,
      'a killed probe is not evidence of a missing bus; it must read as "no answer"');
    assert.notEqual(r.detail, selfCheck.NO_USER_BUS_DETAIL);
  });

  it('bus is there and the timer is dead: fails, and names the state', async () => {
    setBus();
    const r = await selfCheck.checkSchedulerLinux();
    assert.equal(r.status, 'fail',
      'the fix must not silence the failure this check exists to report');
    assert.match(r.detail, /inactive/,
      'the operator needs the state word; a bare "systemctl failed" reads like the old bus error');
    assert.match(r.fix, /systemctl --user enable --now/,
      'a failure has to carry the command that repairs it');
  });

  it('bus is there and the timer is active: passes', async () => {
    setBus();
    setActive();
    const r = await selfCheck.checkSchedulerLinux();
    assert.equal(r.status, 'pass');
    assert.doesNotMatch(r.detail, /skip/i,
      'a timer that really is active must not be reported as skipped');
  });

  it('the happy path costs one systemctl call', async () => {
    setBus();
    setActive();
    await selfCheck.checkSchedulerLinux();
    const lines = calls().trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1,
      'an active timer answers on its own; probing the bus as well is a second process on every healthy machine');
  });
});
