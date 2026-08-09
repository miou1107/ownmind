import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/**
 * v1.17.85 — interactive-upgrade.ps1 Fail function PowerShell smoke test
 *
 * Mirrors install-failed-beacon.test.js (bash version) — symmetric on both ends (IR-022).
 *
 * Real intent: confirm the ps1 Fail really calls Report-Error before throwing, so the PS
 * side doesn't slip through. The way we extract the Fail function is similar to the bash
 * version — pull it from the real interactive-upgrade.ps1 + dot-source a mock Report-Error
 * stub that records calls.
 *
 * v1.26.106 — this test had not passed anywhere since it was written, and nobody could tell.
 * Two reasons, and the second one is why the first went unnoticed for so long:
 *
 *  1. It extracted `function Fail` alone. Fail interpolates `$(Get-LastLogLines $LogFile)`
 *     into the Report-Error call, and Get-LastLogLines is defined further down the same
 *     script, so the harness never had it. PowerShell raised CommandNotFoundException while
 *     building the argument — before Report-Error was ever invoked — and Fail's own
 *     `catch { }` swallowed it. Report-Error was therefore never called, the record file was
 *     never written, and the failure surfaced as a bare ENOENT on a path in os.tmpdir().
 *     Dependencies are now pulled from the real script transitively (see collectDefinition),
 *     so a future dependency comes along for the ride instead of silently voiding the test.
 *
 *  2. It looked only for `pwsh`. macOS dev machines have no PowerShell at all, and Windows
 *     ships Windows PowerShell 5.1 as `powershell` — which is what install.ps1 actually
 *     invokes in production. So the suite skipped on the Mac and skipped on Windows, and a
 *     skipped test looks exactly like a passing one. It now falls back to 5.1 on win32,
 *     which is both wider coverage and closer to what ships.
 *
 * The old assertion `r.status === 1` could not tell "Fail threw and the catch exited 1" from
 * "the script fell over for some other reason and PowerShell exited 1" — the two are the same
 * number. The harness now exits 3 from the catch, a code nothing else here produces, and
 * records the thrown message so the throw itself is checked rather than assumed.
 */

// Production runs this script under whatever PowerShell the box has: install.ps1 calls
// `powershell`, i.e. Windows PowerShell 5.1. Prefer pwsh, fall back to 5.1 on Windows.
const POWERSHELL = (() => {
  const candidates = process.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh'];
  for (const exe of candidates) {
    const r = spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
    });
    if (r.status === 0) return exe;
  }
  return null;
})();

const ps1Path = path.join(repoRoot, 'scripts', 'interactive-upgrade.ps1');

/**
 * Pull `function <name>` out of the script text. Handles both shapes the file uses:
 * `function Fail($code, $msg) {` and `function Get-LastLogLines {` with a param block.
 */
function extractFunction(source, name) {
  const re = new RegExp(`function ${name}\\s*(?:\\([^)]*\\))?\\s*\\{[\\s\\S]*?\\n\\}`);
  const m = source.match(re);
  return m ? m[0] : null;
}

/**
 * Everything the given body needs that the script itself defines, transitively.
 *
 * A Verb-Noun token that interactive-upgrade.ps1 declares as a function is a dependency the
 * harness has to supply; one it does not declare is a real cmdlet (Get-Command, Add-Content)
 * and PowerShell will resolve it. Deriving that from the source rather than from a hand-kept
 * list is the point: the next dependency added to Fail is picked up here instead of turning
 * this test into a silent no-op again.
 */
function collectDefinitions(source, body, provided, seen = new Set()) {
  const out = [];
  for (const [, name] of body.matchAll(/\b([A-Z][a-z]+-[A-Z][A-Za-z]+)\b/g)) {
    if (seen.has(name) || provided.has(name)) continue;
    const def = extractFunction(source, name);
    if (!def) continue; // not declared here, so it is a real cmdlet
    seen.add(name);
    out.push(...collectDefinitions(source, def, provided, seen), def);
  }
  return out;
}

describe('v1.17.85 — interactive-upgrade.ps1 Fail observation (runs wherever a PowerShell exists)', { skip: !POWERSHELL }, () => {
  let tmpDir;
  let recordFile;
  let thrownFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-ps1-fail-'));
    recordFile = path.join(tmpDir, 'report-error-calls.txt');
    thrownFile = path.join(tmpDir, 'thrown.txt');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the Fail function calls Report-Error before throwing (does not depend on the caller calling first)', () => {
    const ps1Content = fs.readFileSync(ps1Path, 'utf8');

    const failDef = extractFunction(ps1Content, 'Fail');
    assert.ok(failDef, 'could not find the function Fail definition in interactive-upgrade.ps1');

    // Report-Error is the thing under observation, so the harness supplies it, not the script.
    const helpers = collectDefinitions(ps1Content, failDef, new Set(['Report-Error']));
    assert.ok(
      helpers.some((d) => d.startsWith('function Get-LastLogLines')),
      'Fail interpolates Get-LastLogLines; if that stopped being true, this harness is testing '
        + 'something other than what ships and the rest of the assertions mean less than they look',
    );

    // ReasonMaxChars is a script-scope variable Get-LastLogLines reads. Take the real
    // assignment rather than inventing a number, so the two cannot drift apart.
    const reasonMax = ps1Content.match(/^\$script:ReasonMaxChars\s*=\s*\d+/m);
    assert.ok(reasonMax, 'could not find the $script:ReasonMaxChars assignment');

    const esc = (s) => s.replace(/\\/g, '\\\\');
    const fakeScript = [
      '$ErrorActionPreference = "Continue"',
      `$LogFile = "${esc(tmpDir)}\\\\fake.log"`,
      '"" | Out-File -FilePath $LogFile -Encoding utf8',
      reasonMax[0],
      // Mock Report-Error: write the args into the record file
      'function Report-Error {',
      '  param($Kind, $Detail, $ContextFile = "")',
      `  Add-Content -LiteralPath "${esc(recordFile)}" -Value "kind=$Kind|detail=$Detail|context=$ContextFile" -Encoding utf8`,
      '}',
      ...helpers,
      failDef,
      // exit 3, not 1: 1 is what PowerShell exits with when the script itself falls over, and
      // the whole question here is which of the two happened.
      `try { Fail "no_ownmind" "test detail" } catch { $_.Exception.Message | Out-File -LiteralPath "${esc(thrownFile)}" -Encoding utf8; exit 3 }`,
    ].join('\n');

    const scriptPath = path.join(tmpDir, 'test.ps1');
    fs.writeFileSync(scriptPath, fakeScript);

    const r = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      encoding: 'utf8',
    });

    const context = () => `\nexit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`;

    assert.equal(r.status, 3, `Fail should have thrown and been caught${context()}`);
    assert.ok(fs.existsSync(thrownFile), `the catch never ran${context()}`);
    assert.match(fs.readFileSync(thrownFile, 'utf8'), /ERROR:no_ownmind:test detail/);

    assert.ok(
      fs.existsSync(recordFile),
      `Fail threw without calling Report-Error first — that is the regression this test exists `
        + `to catch. Note Fail wraps the call in catch { }, so a dependency it cannot resolve `
        + `looks identical to it choosing not to report.${context()}`,
    );
    const record = fs.readFileSync(recordFile, 'utf8');
    assert.match(record, /kind=upgrade_failed_terminal_no_ownmind/);
    assert.match(record, /detail=test detail/);
  });
});
