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
 * Environments where PowerShell is unavailable (pwsh not installed) → skip, don't block CI.
 *
 * Real intent: confirm the ps1 Fail really calls Report-Error before throwing, so the PS
 * side doesn't slip through. The way we extract the Fail function is similar to the bash
 * version — pull it from the real interactive-upgrade.ps1 + dot-source a mock Report-Error
 * stub that records calls.
 */

const PWSH = (() => {
  const r = spawnSync('pwsh', ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? 'pwsh' : null;
})();

describe('v1.17.85 — interactive-upgrade.ps1 Fail observation (runs when pwsh is available)', { skip: !PWSH }, () => {
  let tmpDir;
  let recordFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-ps1-fail-'));
    recordFile = path.join(tmpDir, 'report-error-calls.txt');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the Fail function calls Report-Error before throwing (does not depend on the caller calling first)', () => {
    // Extract the real Fail function definition + mock Report-Error to write calls into the record file
    const ps1Path = path.join(repoRoot, 'scripts', 'interactive-upgrade.ps1');
    const ps1Content = fs.readFileSync(ps1Path, 'utf8');

    // Grab the real Fail function definition (from 'function Fail' to the closing brace)
    const failMatch = ps1Content.match(/function Fail\([^)]*\)\s*\{[\s\S]*?\n\}/);
    if (!failMatch) {
      assert.fail('找不到 interactive-upgrade.ps1 裡的 function Fail 定義');
    }
    const failDef = failMatch[0];

    const recordFileEscaped = recordFile.replace(/\\/g, '\\\\');
    const fakeScript = [
      '$ErrorActionPreference = "Continue"',
      `$LogFile = "${tmpDir.replace(/\\/g, '\\\\')}\\fake.log"`,
      '"" | Out-File -FilePath $LogFile -Encoding utf8',
      // Mock Report-Error: write the args into the record file
      'function Report-Error {',
      '  param($Kind, $Detail, $ContextFile = "")',
      `  Add-Content -LiteralPath "${recordFileEscaped}" -Value "kind=$Kind|detail=$Detail|context=$ContextFile" -Encoding utf8`,
      '}',
      failDef,
      'try { Fail "no_ownmind" "test detail" } catch { exit 1 }',
    ].join('\n');

    const scriptPath = path.join(tmpDir, 'test.ps1');
    fs.writeFileSync(scriptPath, fakeScript);

    const r = spawnSync(PWSH, ['-NoProfile', '-File', scriptPath], { encoding: 'utf8' });
    assert.equal(r.status, 1, 'Fail throw → catch exit 1');

    const record = fs.readFileSync(recordFile, 'utf8');
    assert.match(record, /kind=upgrade_failed_terminal_no_ownmind/);
    assert.match(record, /detail=test detail/);
  });
});
