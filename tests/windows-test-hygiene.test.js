import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CIM_TIMEOUT_MS, describeSpawnFailure } = require('../scripts/install-helpers/self-check.cjs');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const testsDir = join(repoRoot, 'tests');
const testFiles = readdirSync(testsDir).filter((f) => f.endsWith('.test.js'));
const read = (f) => readFileSync(join(testsDir, f), 'utf8');

/**
 * v1.26.106 — the suite's own Windows blind spots.
 *
 * This repository has no CI. Tests run wherever someone runs them, which in practice is one
 * developer's machine, and a test that cannot pass on the other platform is not a failing
 * test to that developer — it is an invisible one. Three separate defects lived in here:
 *
 *   - four files built paths with `new URL(...).pathname`, which on Windows yields
 *     '/C:/Users/...'. install-artifacts.test.js died with MODULE_NOT_FOUND before its first
 *     assertion; three others threw ENOENT.
 *   - git-bash-detection.test.js spawned PowerShell without -ExecutionPolicy Bypass, so on a
 *     Windows client with default policy it failed with UnauthorizedAccess. macOS skips that
 *     describe for lack of PowerShell, so the only test that runs the Git Bash detector could
 *     not pass on either platform.
 *   - its .cmd stub did not escape cmd.exe metacharacters, and the real `bash --version`
 *     third line ends in '<http://...>'. cmd read the '<' as redirection.
 *
 * The checks below are greps, which is a weak form of test — but the thing being guarded is
 * itself a property of the test sources, and a grep runs on the platform that cannot run the
 * code.
 */

// `import.meta.dirname` (Node 20.11+) is the other correct answer, so the pattern is only a
// defect when nothing catches it. Matching the guarded form keeps this from firing on the
// files that already do the right thing.
const BARE_PATHNAME = /(?<!\|\|\s{0,4})new URL\([^)]*import\.meta\.url\)\.pathname(?!\s*\.replace)/;

describe('test files must build paths in a way that works on Windows', () => {
  for (const f of testFiles) {
    it(`${f} does not use a bare new URL(...).pathname`, () => {
      const src = read(f);
      const offenders = src
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => BARE_PATHNAME.test(line))
        .filter(({ line }) => !/import\.meta\.dirname/.test(line));
      assert.deepEqual(offenders.map((o) => `${f}:${o.n}`), [],
        'on Windows a file: URL pathname is "/C:/Users/..." and node resolves it to '
        + '"C:\\C:\\Users\\..."; use fileURLToPath(new URL(...)) or import.meta.dirname');
    });
  }
});

describe('shipping code must build paths in a way that works on Windows too', () => {
  // The first version of this suite scanned `tests/` only, on the reasoning that the defect
  // it had just found lived there. It lived in shipping code as well: the commit-msg hook
  // added one release earlier resolved its own directory the same way, so on Windows its
  // `../shared/helpers.js` import could not resolve — and that hook exits 0 on any failure,
  // by design, so every commit-message rule was silently unenforced there.
  //
  // A guard that only looks where the last bug was found will keep finding the last bug.
  const SOURCE_DIRS = ['hooks', 'mcp', 'scripts', 'shared', 'src'];
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'public', 'cache', '.git']);

  function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(js|cjs|mjs)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it('no shipping file resolves its own directory through a bare .pathname', () => {
    const offenders = [];
    for (const dir of SOURCE_DIRS) {
      let files;
      try { files = walk(join(repoRoot, dir)); } catch { continue; }
      for (const full of files) {
        readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
          if (BARE_PATHNAME.test(line) && !/import\.meta\.dirname/.test(line)) {
            offenders.push(`${full.slice(repoRoot.length)}:${i + 1}`);
          }
        });
      }
    }
    assert.deepEqual(offenders, [],
      'on Windows a file: URL pathname is "/C:/Users/..."; use fileURLToPath or '
      + 'import.meta.dirname. A hook that cannot resolve its own imports exits without '
      + 'running, and these hooks are built to fail quietly.');
  });
});

describe('tests that spawn PowerShell must not be blocked by execution policy', () => {
  // Case-insensitive, and `pwsh` as well as `powershell`: the first version required a
  // quoted lowercase "powershell", so a file spawning a `PWSH` const was never inspected —
  // and one such file was violating the very rule below. A guard that picks its own subjects
  // is only as good as the pick.
  const spawnsPowerShell = testFiles.filter((f) => /pwsh|powershell/i.test(read(f)));

  it('at least one file spawns PowerShell, or this whole suite is vacuous', () => {
    assert.ok(spawnsPowerShell.length > 0,
      'no PowerShell spawn found — the detection regex is stale, not the problem solved');
  });

  for (const f of spawnsPowerShell) {
    it(`${f} passes -ExecutionPolicy Bypass to every PowerShell spawn that runs a script`, () => {
      const src = read(f);
      // A Windows client whose policy was never configured is Restricted, so dot-sourcing or
      // running any .ps1 fails. Every shipped caller already passes this flag.
      //
      // Execution policy governs script *files*, not inline text, so a spawn whose -Command
      // is a string literal ('exit 0', used to probe whether PowerShell exists at all) is
      // exempt — requiring the flag there would be cargo cult, and the kind of noise that
      // gets a rule switched off. The spawns that matter pass a variable holding a script.
      // Any argument array containing -NoProfile, however it is quoted and whatever comes
      // first. The original anchored on a single-quoted '-NoProfile' as element one, so an
      // array starting with '-ExecutionPolicy' — or using double quotes — went unchecked.
      const spawns = src.match(/\[[^\[\]]*-NoProfile[^\[\]]*\]/g) || [];
      const runsAScript = spawns.filter((s) => !/-Command['"]\s*,\s*['"][^'"]*['"]/.test(s));
      for (const s of runsAScript) {
        assert.match(s, /-ExecutionPolicy'\s*,\s*'Bypass/,
          `a PowerShell spawn in ${f} omits -ExecutionPolicy Bypass: ${s.slice(0, 90)}`);
      }
    });
  }
});

describe('cmd.exe stubs must escape metacharacters', () => {
  it('git-bash-detection.test.js escapes its echo arguments', () => {
    const src = read('git-bash-detection.test.js');
    assert.match(src, /replace\(\/\\\^\/g, '\^\^'\)/,
      'the caret must be escaped first or it double-escapes what follows');
    assert.match(src, /\[&<>\|\(\)\]/,
      'cmd redirection and grouping characters must be escaped in a generated .cmd');
  });
});

describe('the Windows scheduler check has a budget sized for the call it makes', () => {
  it('does not reuse the generic 5s timeout for a CIM cmdlet', () => {
    // Measured on an idle Windows 10 box: Get-ScheduledTask answers in ~1.5s, five runs,
    // warm. self-check runs at the end of an install, when the machine is at its busiest,
    // and a timeout there is uploaded as a hard `fail` for a healthy scheduler.
    assert.ok(CIM_TIMEOUT_MS >= 15000,
      `CIM_TIMEOUT_MS is ${CIM_TIMEOUT_MS}ms; Get-ScheduledTask alone costs ~1500ms idle`);
  });

  it('both functions that query Task Scheduler use it', () => {
    // Located by function, not by matching the safeSpawn call text: detectSchedulerDetail
    // builds its command in a variable, so the call site never contains the string
    // "Get-ScheduledTask" and a grep for that would quietly check only half of them.
    const src = readFileSync(join(repoRoot, 'scripts', 'install-helpers', 'self-check.cjs'), 'utf8');
    for (const name of ['checkScheduler', 'detectSchedulerDetail']) {
      const m = new RegExp(`(?:async )?function ${name}\\b[\\s\\S]*?\\n\\}`).exec(src);
      assert.ok(m, `${name} not found — this test is looking at a stale shape`);
      assert.match(m[0], /Get-ScheduledTask/, `${name} should be the one that queries the scheduler`);
      assert.match(m[0], /CIM_TIMEOUT_MS/,
        `${name} still runs a CIM cmdlet on the generic 5s budget`);
    }
  });
});

describe('a spawn failure keeps the evidence it was diagnosed from', () => {
  // IR-003: the failure path must not destroy the diagnostic. safeSpawn captured killed and
  // signal; the caller quoted only `error`, which for a timeout is "Command failed: <cmd>"
  // and reads as "your command is wrong" — the one thing it is not.
  it('names a timeout as a timeout', () => {
    const out = describeSpawnFailure({
      killed: true, signal: 'SIGTERM', code: null, error: 'Command failed: powershell.exe ...',
    });
    assert.match(out, /timed out/);
    assert.match(out, /SIGTERM/);
  });

  it('keeps the exit code and stderr when the process really failed', () => {
    const out = describeSpawnFailure({
      killed: false, code: 1, signal: null, error: 'Command failed', stderr_tail: 'ObjectNotFound',
    });
    assert.match(out, /code=1/);
    assert.match(out, /ObjectNotFound/);
    assert.doesNotMatch(out, /timed out/);
  });

  it('does not throw on a malformed result, and still says something', () => {
    // `typeof === 'string'` alone is satisfied by '', which reaches the server as
    // "Get-ScheduledTask failed: " with nothing after the colon — a report that costs
    // somebody a round trip to find out it says nothing.
    assert.equal(typeof describeSpawnFailure(null), 'string');
    assert.ok(describeSpawnFailure(null).length > 0);
    assert.equal(typeof describeSpawnFailure({}), 'string');
    assert.ok(describeSpawnFailure({}).length > 0, 'an empty result must still describe itself');
  });
});
