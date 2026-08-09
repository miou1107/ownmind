// v1.26.79 — the auto-update path must notice a dead scanner schedule and put it back.
//
// Traced from production on 2026-08-06. Adam's collector heartbeat shows the shape
// plainly: his claude-code row moved today at 11:36 carrying 1.26.67, while the four
// rows the scanner writes have not moved since 2026-07-15 and still carry 1.26.29. His
// MCP is alive, auto-updating, and reaching the server. The scheduled task that reads his
// token data is gone, and has been for three weeks.
//
// `interactive-upgrade.ps1` already re-registers the task, and its own comment records why
// (「Adam 因此斷了二十天」). But only `bootstrap.ps1` reaches that script, and nobody runs
// bootstrap by hand. The auto-update path is `mcp/index.js` → `update.ps1` / `update.sh`,
// and neither of those has ever looked at the schedule. So the one repair we built for
// this exact failure sits on a road the failure never travels.
//
// The Unix helper is exercised for real: a temp HOME, a stub `launchctl` / `systemctl` on
// PATH, and assertions on what the helper did. The stub stands in for the OS, not for our
// own code — faking both sides of a contract is what let the last three defects through
// (IR-128). The PowerShell side cannot execute on this machine, so it is read as text, the
// same level `ps1-windows-compat.test.js` and `scanner-task-durability.test.js` work at.
//
// What the text-level tests cannot catch, stated rather than glossed over. An adversarial
// review named these mutations and they are all real:
//   - `if (-not $task)` changed to `if ($false)` — the string still reads correctly.
//   - the call in update.sh wrapped in `if false; then ... fi` — the filename is still
//     present in the file.
// Two others it named have since been closed: both "reports the failure" assertions now
// look inside the failure path rather than anywhere in the file, because each helper also
// defines a no-op reporting fallback that a whole-file match would keep matching after
// someone deleted the real call. Both were mutation-checked with the fallback left in
// place, and both go red.
//
// Closing the first two would mean executing update.sh and PowerShell, which this machine
// cannot do for one of them and should not do for the other (update.sh installs packages
// and writes into ~/.claude). Backlog item 24 is where the Windows half gets settled.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// Strip PowerShell / shell comments so prose about a command is never mistaken for a call.
const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const HELPER_SH = 'scripts/install-helpers/ensure-scanner-schedule.sh';
const HELPER_PS1 = 'scripts/install-helpers/ensure-scanner-schedule.ps1';
const LABEL = 'com.ownmind.usage-scanner';

// ---------------------------------------------------------------------------
// A sandbox: temp HOME with the bits of ~/.ownmind the helper reads, plus stub
// launchctl / systemctl binaries whose behaviour the test controls through files.
// ---------------------------------------------------------------------------

let sandbox;

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-sched-'));
  // A deliberately hostile home directory. `&` is the one that matters: in sed's
  // replacement text it means "everything that matched", so an unescaped substitution
  // writes the literal `{HOME}` back into the plist and produces a file launchd cannot
  // parse. A benign path like /tmp/x/home lets that bug pass every assertion below.
  const home = path.join(root, 'ho me & you');
  const ownmind = path.join(home, '.ownmind');
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  for (const d of [home, ownmind, bin, state,
    path.join(ownmind, 'scripts', 'launchd'),
    path.join(ownmind, 'scripts', 'systemd'),
    path.join(ownmind, 'logs')]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // Real templates, so a rename or a broken placeholder in them fails this test too.
  fs.copyFileSync(
    path.join(repoRoot, 'scripts/launchd/com.ownmind.usage-scanner.plist'),
    path.join(ownmind, 'scripts/launchd/com.ownmind.usage-scanner.plist'),
  );
  for (const unit of ['ownmind-usage-scanner.service', 'ownmind-usage-scanner.timer']) {
    fs.copyFileSync(
      path.join(repoRoot, 'scripts/systemd', unit),
      path.join(ownmind, 'scripts/systemd', unit),
    );
  }

  const stub = (name, body) => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/bash\nSTATE="${state}"\n${body}\n`);
    fs.chmodSync(p, 0o755);
  };

  // `launchctl list <label>` exits 0 when the agent is loaded, non-zero when it is not.
  stub('launchctl', `
printf '%s\\n' "$*" >> "$STATE/launchctl.calls"
case "$1" in
  list)   [ -f "$STATE/loaded" ] && exit 0 || exit 1 ;;
  load)   [ -f "$STATE/fail_load" ] && exit 1; touch "$STATE/loaded"; exit 0 ;;
  unload) rm -f "$STATE/loaded"; exit 0 ;;
esac
exit 0`);

  // `active` and `enabled` are separate files on purpose. Tying both answers to one flag
  // would make the sandbox physically unable to represent "running now but gone after a
  // reboot", which is the state the helper checks two commands to catch.
  // `show-environment` stands in for "is there a systemd user session at all" — on WSL
  // and headless boxes there is not, and that must not be mistaken for a broken timer.
  stub('systemctl', `
printf '%s\\n' "$*" >> "$STATE/systemctl.calls"
for a in "$@"; do
  case "$a" in
    show-environment) [ -f "$STATE/no_user_bus" ] && exit 1 || exit 0 ;;
    is-active)        [ -f "$STATE/active" ]  && exit 0 || exit 1 ;;
    is-enabled)       [ -f "$STATE/enabled" ] && exit 0 || exit 1 ;;
    enable)           [ -f "$STATE/fail_load" ] && exit 1
                      touch "$STATE/active" "$STATE/enabled"; exit 0 ;;
  esac
done
exit 0`);

  return { root, home, ownmind, bin, state };
}

const STATE_FILES = ['loaded', 'active', 'enabled', 'fail_load', 'no_user_bus',
  'launchctl.calls', 'systemctl.calls'];

function runHelper({
  osType = 'darwin', loaded = false, failLoad = false,
  active = loaded, enabled = loaded, noUserBus = false,
} = {}) {
  const { state } = sandbox;
  for (const f of STATE_FILES) fs.rmSync(path.join(state, f), { force: true });
  if (loaded) fs.writeFileSync(path.join(state, 'loaded'), '');
  if (active) fs.writeFileSync(path.join(state, 'active'), '');
  if (enabled) fs.writeFileSync(path.join(state, 'enabled'), '');
  if (failLoad) fs.writeFileSync(path.join(state, 'fail_load'), '');
  if (noUserBus) fs.writeFileSync(path.join(state, 'no_user_bus'), '');

  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync('bash', [path.join(repoRoot, HELPER_SH)], {
      env: {
        ...process.env,
        HOME: sandbox.home,
        OWNMIND_OS: osType,
        PATH: `${sandbox.bin}:${process.env.PATH}`,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    code = e.status ?? 1;
    stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const calls = (name) => {
    try { return fs.readFileSync(path.join(state, `${name}.calls`), 'utf8'); }
    catch { return ''; }
  };
  return { stdout, code, launchctl: calls('launchctl'), systemctl: calls('systemctl') };
}

// v1.26.106 — the two plist assertions below used to call `plutil`, which exists only on
// macOS. Everywhere else they threw ENOENT, and because nothing ran this suite off a Mac
// until CI existed, "macOS: …" quietly meant "nowhere". The claims themselves are about a
// generated XML file and hold on any platform, so they are checked here directly, and plutil
// is still consulted when it is present — it is the parser launchd itself uses, and no
// hand-written check earns the right to replace it.
const HAS_PLUTIL = (() => {
  const r = spawnSync('plutil', ['-help'], { encoding: 'utf8' });
  return !r.error;
})();

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlText(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(XML_ENTITIES, body) ? XML_ENTITIES[body] : whole;
  });
}

/**
 * Well-formedness, limited to the two ways this generator can produce a broken file.
 *
 * A bare `&` is the important one: the plist is built by substituting HOME into a template
 * with sed, and `&` is sed's "the whole match" metacharacter. Unescaped, it corrupts the
 * output; in XML it also starts an entity that never terminates, which is precisely why
 * launchd refuses the file. Tag balance is the other: a truncated write leaves a file that
 * still looks plausible in a substring search.
 */
function assertWellFormedPlist(xml, context) {
  const bareAmp = xml.match(/&(?!(?:#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);)/);
  assert.equal(
    bareAmp,
    null,
    `${context}: an & that starts no entity — sed's replacement metacharacter survived`,
  );

  const stack = [];
  const body = xml.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<![^>]*>/g, '');
  for (const [, closing, name, selfClosing] of body.matchAll(/<(\/)?([A-Za-z][\w:.-]*)[^>]*?(\/)?>/g)) {
    if (selfClosing) continue;
    if (closing) {
      assert.equal(stack.pop(), name, `${context}: </${name}> does not close the open element`);
    } else {
      stack.push(name);
    }
  }
  assert.deepEqual(stack, [], `${context}: unclosed elements`);
}

/** The decoded <string> values of the <array> that follows <key>name</key>. */
function plistStringArray(xml, name) {
  const key = xml.indexOf(`<key>${name}</key>`);
  assert.notEqual(key, -1, `plist has no <key>${name}</key>`);
  const open = xml.indexOf('<array>', key);
  const close = xml.indexOf('</array>', open);
  assert.ok(open !== -1 && close !== -1, `<key>${name}</key> is not followed by an <array>`);
  return [...xml.slice(open, close).matchAll(/<string>([\s\S]*?)<\/string>/g)]
    .map((m) => decodeXmlText(m[1]));
}

describe('ensure-scanner-schedule.sh — repairs a dead schedule, leaves a live one alone', () => {
  before(() => { sandbox = makeSandbox(); });
  after(() => { if (sandbox) fs.rmSync(sandbox.root, { recursive: true, force: true }); });

  it('exists and is executable by bash', () => {
    assert.ok(fs.existsSync(path.join(repoRoot, HELPER_SH)), `${HELPER_SH} is missing`);
  });

  it('macOS: loads the launchd agent when it is not loaded', () => {
    const r = runHelper({ osType: 'darwin', loaded: false });
    assert.equal(r.code, 0, `helper failed: ${r.stdout}`);
    assert.match(r.launchctl, /^load /m, 'never called launchctl load');
    assert.match(r.stdout, /repaired/i, 'did not report that it repaired anything');
  });

  it('macOS: writes the plist with {HOME} substituted, not left as a placeholder', () => {
    runHelper({ osType: 'darwin', loaded: false });
    const plist = path.join(sandbox.home, 'Library/LaunchAgents', `${LABEL}.plist`);
    assert.ok(fs.existsSync(plist), 'plist was not written to ~/Library/LaunchAgents');
    const body = fs.readFileSync(plist, 'utf8');
    // sandbox.home contains `&` and a space, so this is also the regression test for
    // sed's replacement metacharacters. Unescaped, the `&` puts `{HOME}` back and this
    // first assertion fires.
    assert.doesNotMatch(body, /\{HOME\}/, '{HOME} placeholder was left unsubstituted');

    // Read the path back the way launchd will, decoding entities. A raw substring search
    // would be wrong in both directions: it fails on a correctly encoded `&amp;`, and it
    // would pass on a file that happens to contain the right characters in the wrong element.
    // The helper writes this path from inside bash, so its spelling is bash's view of the
    // filesystem. Under Git Bash on Windows the same directory is /tmp/… where node calls it
    // C:\Users\…\Temp\…, and asserting on path.join's answer compares two correct spellings
    // of one directory and calls the difference a defect. What the case is actually about is
    // that {HOME} was substituted and that the `&` in the directory name survived sed, so it
    // is checked against the part of the path that carries both.
    const homeTail = sandbox.home.split(/[\\/]/).slice(-2).join('/');
    const assertArgs = (args, source) => {
      assert.deepEqual(args.slice(0, 1), ['/bin/bash'], `${source}: not run through bash`);
      assert.equal(args.length, 2, `${source}: expected exactly one script argument`);
      assert.ok(
        args[1].endsWith(`${homeTail}/.ownmind/bin/run-scanner.sh`),
        `${source}: the scheduled command does not point at this HOME — got ${args[1]}`,
      );
    };

    assertArgs(plistStringArray(body, 'ProgramArguments'), 'plist');

    if (HAS_PLUTIL) {
      const parsed = JSON.parse(
        execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }),
      );
      assertArgs(parsed.ProgramArguments, 'plutil');
    }
  });

  it('macOS: the plist it writes is a file launchd can actually parse', () => {
    // "no {HOME} left" and "well-formed" are different claims, and a corrupt plist is
    // worse than no plist: it survives on disk and every later load fails.
    runHelper({ osType: 'darwin', loaded: false });
    const plist = path.join(sandbox.home, 'Library/LaunchAgents', `${LABEL}.plist`);
    assertWellFormedPlist(fs.readFileSync(plist, 'utf8'), 'generated plist');

    // plutil is the parser launchd itself uses, so where it exists its verdict is the one
    // that counts. Where it does not, the check above still runs rather than the case
    // disappearing — a skipped assertion and a passing one look identical in a summary.
    if (HAS_PLUTIL) {
      const out = execFileSync('plutil', ['-lint', plist], { encoding: 'utf8' });
      assert.match(out, /OK/, `plutil rejected the generated plist: ${out}`);
    }
  });

  it('macOS: does nothing when the agent is already loaded', () => {
    // The repair must be idempotent. It runs on every auto-update, and reloading a
    // healthy agent would reset its timer and re-run the scanner for no reason.
    const r = runHelper({ osType: 'darwin', loaded: true });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.launchctl, /^load /m, 'reloaded an agent that was already fine');
    assert.doesNotMatch(r.launchctl, /^unload /m, 'unloaded a healthy agent');
  });

  it('macOS: fails loudly when the repair does not take', () => {
    // The whole defect being fixed is a schedule that dies without anyone hearing.
    // A repair that silently fails to repair reproduces it exactly.
    const r = runHelper({ osType: 'darwin', loaded: false, failLoad: true });
    assert.notEqual(r.code, 0, 'exited 0 even though the agent never loaded');
    assert.match(r.stdout, /ERROR:schedule/, 'no machine-readable error line');
  });

  it('Linux: enables the systemd timer when it is not active', () => {
    const r = runHelper({ osType: 'linux-gnu', loaded: false });
    assert.equal(r.code, 0, `helper failed: ${r.stdout}`);
    assert.match(r.systemctl, /enable/, 'never enabled the timer');
    const unit = path.join(sandbox.home, '.config/systemd/user/ownmind-usage-scanner.timer');
    assert.ok(fs.existsSync(unit), 'timer unit was not installed');
  });

  it('Linux: does nothing when the timer is both active and enabled', () => {
    const r = runHelper({ osType: 'linux-gnu', active: true, enabled: true });
    assert.equal(r.code, 0);
    // `enable` as its own word, so the health probe `is-enabled` is not mistaken for it.
    assert.doesNotMatch(r.systemctl, /(^|\s)enable(\s|$)/m,
      're-enabled a timer that was already fine');
  });

  it('Linux: repairs a timer that runs now but would not survive a reboot', () => {
    // active without enabled is a schedule that dies at the next restart — the same
    // defect on a delay. Checking only is-active would call this healthy.
    const r = runHelper({ osType: 'linux-gnu', active: true, enabled: false });
    assert.equal(r.code, 0, `helper failed: ${r.stdout}`);
    assert.match(r.systemctl, /(^|\s)enable(\s|$)/m,
      'left a timer that will not come back after a reboot');
    assert.match(r.stdout, /repaired/i);
  });

  it('Linux: stays quiet on a box with no systemd user session at all', () => {
    // WSL and headless containers cannot reach a user D-Bus, so `systemctl --user`
    // always fails. Treating that as a broken timer would report a failure from every
    // such machine on every update, and bury the real ones this report exists to surface.
    const r = runHelper({ osType: 'linux-gnu', noUserBus: true });
    assert.equal(r.code, 0, 'reported a failure on a machine with nothing to repair');
    assert.match(r.stdout, /skipped/i);
    assert.doesNotMatch(r.systemctl, /(^|\s)enable(\s|$)/m,
      'tried to enable a timer with no user session to put it in');
  });

  it('reports the failure to the server rather than only to a terminal nobody watches', () => {
    // Adam's schedule died in silence for twenty days. A repair that fails on his machine
    // must leave a trace somewhere Vin can see, which is the report-error channel.
    //
    // The assertion looks *inside* the failure path, not anywhere in the file. This file
    // also defines a no-op `report_error() { :; }` fallback for when the helper is
    // missing, so a whole-file grep would keep passing after someone deleted the real
    // call and left the polyfill behind.
    const src = read(HELPER_SH);
    const failFn = src.match(/^fail\(\)\s*\{[\s\S]*?^\}/m);
    assert.ok(failFn, 'no fail() function to inspect');
    assert.match(failFn[0], /report_error\s+"scanner_schedule_repair_failed"/,
      'the failure path does not report anything; a failed repair would be invisible');
  });
});

describe('the auto-update path actually calls the repair', () => {
  it('update.sh runs the ensure helper', () => {
    // This is the whole point. interactive-upgrade.ps1 has had the repair since v1.26.65
    // and it never reached Adam, because auto-update does not go through it.
    const src = codeOnly(read('scripts/update.sh'));
    assert.match(src, /ensure-scanner-schedule\.sh/,
      'update.sh never checks whether the scanner schedule is alive');
  });

  it('update.ps1 runs the ensure helper', () => {
    const src = codeOnly(read('scripts/update.ps1'));
    assert.match(src, /ensure-scanner-schedule\.ps1/,
      'update.ps1 never checks whether the scanner scheduled task is alive');
  });

  it('mcp/index.js still invokes update.sh / update.ps1 after pulling', () => {
    // The repair only reaches a user if the freshly pulled script is the one that runs.
    // git pull must come first; if that order ever flips, every fix in these scripts is
    // one release late and this test is the only thing that would say so.
    const src = read('mcp/index.js');
    const pull = src.indexOf("'pull'");
    const sync = src.indexOf("'update.ps1'");
    assert.ok(pull > 0 && sync > 0, 'could not find the pull / sync calls');
    assert.ok(pull < sync, 'update scripts run before git pull, so fixes land one release late');
  });
});

describe('ensure-scanner-schedule.ps1 — same contract on Windows', () => {
  it('exists', () => {
    assert.ok(fs.existsSync(path.join(repoRoot, HELPER_PS1)), `${HELPER_PS1} is missing`);
  });

  it('asks Task Scheduler whether the task is there before deciding anything', () => {
    const src = codeOnly(read(HELPER_PS1));
    assert.match(src, /Get-ScheduledTask/, 'never queries Task Scheduler');
  });

  it('treats a disabled task as broken, not as present', () => {
    // Get-ScheduledTask returns a disabled task happily. A task that exists and never
    // fires is the same outcome for the user as no task at all.
    const src = codeOnly(read(HELPER_PS1));
    assert.match(src, /Disabled/, 'a disabled task would be mistaken for a healthy one');
  });

  it('repairs by delegating to register-scanner-task.ps1 rather than duplicating it', () => {
    const src = codeOnly(read(HELPER_PS1));
    assert.match(src, /register-scanner-task\.ps1/,
      'the registration logic must have exactly one home');
  });

  it('verifies the task is present after repairing', () => {
    const src = codeOnly(read(HELPER_PS1));
    const after = src.slice(src.indexOf('register-scanner-task.ps1'));
    assert.match(after, /Get-ScheduledTask/,
      'nothing confirms the repair worked; this is the original defect again');
  });

  it('never unregisters anything', () => {
    // Same rule scanner-task-durability.test.js pins on register-scanner-task.ps1:
    // delete-then-create has no rollback, and this helper runs unattended.
    const src = codeOnly(read(HELPER_PS1));
    assert.doesNotMatch(src, /Unregister-ScheduledTask/,
      'a repair path must never be able to leave the machine with no task at all');
  });

  it('reports a failed repair to the server', () => {
    // Inside the failure path, for the same reason as the shell side: the file defines a
    // no-op `function Report-Error { param(...) }` fallback, and a whole-file match would
    // survive deleting the real call.
    const src = read(HELPER_PS1);
    const failFn = src.match(/function Fail-Schedule[\s\S]*?\n\}/);
    assert.ok(failFn, 'no Fail-Schedule function to inspect');
    assert.match(failFn[0], /Report-Error\s+-Kind\s+"scanner_schedule_repair_failed"/,
      'the failure path does not report anything; a failed repair on Windows would be invisible');
  });
});

describe('install.sh — registering the Unix schedule must not fail silently', () => {
  // Found while writing this change. register-scanner-task.ps1 has verified its own work
  // since v1.17.12; the macOS and Linux branches of install.sh never have. Worse, the
  // macOS branch unloads before it loads, which is the exact delete-then-create shape
  // v1.26.65 removed from the Windows side.
  const src = read('install.sh');
  const block = src.slice(src.indexOf('4e-4'), src.indexOf('4e-4') + 2500);

  it('confirms the launchd agent is loaded after loading it', () => {
    assert.match(block, /launchctl list/,
      'install.sh trusts launchctl load and never checks the agent is there');
  });

  it('confirms the systemd timer is active after enabling it', () => {
    assert.match(block, /is-active|is-enabled/,
      'install.sh trusts systemctl enable and never checks the timer is running');
  });
});
