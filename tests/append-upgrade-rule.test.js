import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const helper = path.join(repoRoot, 'scripts/windows/lib/append-upgrade-rule.ps1');

/**
 * v1.26.140 — the updater threw on an AI tool whose instruction file existed but was empty.
 *
 * Reported from Windows PowerShell 5.1: `Get-Content -Raw` hands back $null for a zero-byte
 * file, [regex]::Replace() refuses a null input, and the assignment that was supposed to
 * produce $existing never ran — so the next line called .TrimEnd() on $null as well. Both
 * errors are non-terminating, so the updater carried on and printed
 * "[ OK ] Upgrade rules synced to detected AI tools" while that tool got nothing.
 *
 * The three cases below are the ones that distinguish the fix: empty is the reported
 * failure, missing and non-empty are the controls that always worked and must keep working.
 *
 * This runs PowerShell for real rather than asserting on the script's text. The bug was in
 * what PowerShell does with $null, which no amount of reading the source reveals — the
 * previous version of this code reads perfectly.
 */

function pwshAvailable() {
  const probe = spawnSync(
    'pwsh',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '$PSVersionTable.PSVersion.Major'],
    { encoding: 'utf8' }
  );
  return probe.status === 0;
}

const hasPwsh = pwshAvailable();

describe('Add-OwnMindUpgradeRule (PowerShell)', { skip: hasPwsh ? false : 'pwsh not on PATH' }, () => {
  const run = (script) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-rule-'));
    const file = path.join(dir, 'runner.ps1');
    // Same modes update.ps1 sets before it dot-sources the helper. Without StrictMode the
    // helper would be exercised in a laxer mode than the one it actually runs in.
    fs.writeFileSync(
      file,
      `$ErrorActionPreference = 'Stop'\nSet-StrictMode -Version Latest\n. '${helper}'\n$Base = '${dir}'\n${script}`
    );
    const out = execFileSync(
      'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8' }
    );
    return { dir, out };
  };

  const SNIPPET = 'UPGRADE RULE BODY';

  it('an existing empty file receives the rule instead of throwing', () => {
    const { dir, out } = run(`
      $t = Join-Path $Base 'AGENTS.md'
      [System.IO.File]::WriteAllText($t, '')
      $r = Add-OwnMindUpgradeRule -TargetFile $t -Snippet '${SNIPPET}'
      [Console]::WriteLine("result=$r")
    `);
    assert.match(out, /result=written/);
    const body = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(body, /<!-- ownmind-upgrade-rule -->/);
    assert.match(body, new RegExp(SNIPPET));
    assert.match(body, /<!-- \/ownmind-upgrade-rule -->/);
  });

  it('a file that does not exist yet is created with the rule', () => {
    const { dir, out } = run(`
      $t = Join-Path $Base 'AGENTS.md'
      $r = Add-OwnMindUpgradeRule -TargetFile $t -Snippet '${SNIPPET}'
      [Console]::WriteLine("result=$r")
    `);
    assert.match(out, /result=written/);
    assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), new RegExp(SNIPPET));
  });

  it("a file with the user's own content keeps it, with the rule appended", () => {
    const { dir } = run(`
      $t = Join-Path $Base 'AGENTS.md'
      [System.IO.File]::WriteAllText($t, "my own instructions\`n")
      Add-OwnMindUpgradeRule -TargetFile $t -Snippet '${SNIPPET}' | Out-Null
    `);
    const body = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(body, /my own instructions/);
    assert.match(body, new RegExp(SNIPPET));
  });

  /** IR: an operation that runs on every update has to be safe to run twice. */
  it('running twice leaves exactly one rule block, not two', () => {
    const { dir } = run(`
      $t = Join-Path $Base 'AGENTS.md'
      [System.IO.File]::WriteAllText($t, "keep me\`n")
      Add-OwnMindUpgradeRule -TargetFile $t -Snippet 'FIRST' | Out-Null
      Add-OwnMindUpgradeRule -TargetFile $t -Snippet 'SECOND' | Out-Null
    `);
    const body = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.equal(body.match(/<!-- ownmind-upgrade-rule -->/g).length, 1);
    assert.match(body, /SECOND/);
    assert.doesNotMatch(body, /FIRST/);
    assert.match(body, /keep me/);
  });

  it('a tool that is not installed is reported as skipped, not written', () => {
    const { out } = run(`
      $t = Join-Path $Base 'no-such-tool\\ownmind.md'
      $r = Add-OwnMindUpgradeRule -TargetFile $t -Snippet '${SNIPPET}'
      [Console]::WriteLine("result=$r")
    `);
    assert.match(out, /result=skipped/);
  });

  /**
   * The write is BOM-less UTF-8, so the read has to be UTF-8 explicitly. `Get-Content -Raw`
   * on Windows PowerShell 5.1 falls back to the system ANSI code page for a file with no
   * BOM, which would decode this function's own output as Big5 on the machine this bug came
   * from — mangling the user's text and writing the damage back on the next update.
   */
  it("round-trips non-ASCII content the user wrote", () => {
    const chinese = '我自己的規則：先問再改';
    const { dir } = run(`
      $t = Join-Path $Base 'AGENTS.md'
      [System.IO.File]::WriteAllText($t, "${chinese}", (New-Object System.Text.UTF8Encoding $false))
      Add-OwnMindUpgradeRule -TargetFile $t -Snippet '規則內容' | Out-Null
      Add-OwnMindUpgradeRule -TargetFile $t -Snippet '規則內容第二版' | Out-Null
    `);
    const body = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(body, new RegExp(chinese), 'the user\'s own Chinese survived two updates');
    assert.match(body, /規則內容第二版/);
  });

  it('writes BOM-less UTF-8 — other vendors read these files', () => {
    const { dir } = run(`
      $t = Join-Path $Base 'AGENTS.md'
      Add-OwnMindUpgradeRule -TargetFile $t -Snippet '${SNIPPET}' | Out-Null
    `);
    const raw = fs.readFileSync(path.join(dir, 'AGENTS.md'));
    assert.notDeepEqual([raw[0], raw[1], raw[2]], [0xef, 0xbb, 0xbf]);
  });
});

describe('update.ps1 — the fragile patterns must not come back', () => {
  const content = fs.readFileSync(path.join(repoRoot, 'scripts/update.ps1'), 'utf8');
  const helperSource = fs.readFileSync(helper, 'utf8');

  for (const [label, source] of [['update.ps1', content], ['append-upgrade-rule.ps1', helperSource]]) {
    it(`${label} does not pass Get-Content -Raw straight into [regex]::Replace`, () => {
      assert.doesNotMatch(
        source,
        /\[regex\]::Replace\(\s*\(?\s*Get-Content\s+-Raw/,
        'Get-Content -Raw is $null for an empty file and [regex]::Replace rejects null input'
      );
    });

    /**
     * Windows PowerShell 5.1 decodes a BOM-less file in the system ANSI code page. Every
     * file in this flow is UTF-8 without a BOM: the snippet in the repo, and the targets
     * this now writes.
     */
    it(`${label} reads these files as UTF-8 rather than by code page`, () => {
      const code = source.split('\n').filter((l) => !l.trim().startsWith('#'));
      const rawReads = code.filter((l) => /Get-Content\s+-Raw/.test(l));
      const inFlow = rawReads.filter((line) => /Snippet|TargetFile/i.test(line));
      assert.deepEqual(inFlow, [], `use [System.IO.File]::ReadAllText instead: ${inFlow.join(' | ')}`);
    });
  }

  it('uses the extracted helper', () => {
    assert.match(content, /append-upgrade-rule\.ps1/);
    assert.match(content, /Add-OwnMindUpgradeRule/);
  });

  /**
   * The line this release is named after. An earlier version of this test matched the first
   * `Write-Host … Upgrade rules …` in the file, which is the WARN line for a missing helper
   * — it contains a `$`, so the assertion passed while the fixed `[ OK ]` string it was
   * meant to forbid sat untouched three lines below.
   */
  it('the success line reports a count rather than a fixed string', () => {
    const okLine = content.match(/Write-Host[^\n]*\[ OK \][^\n]*Upgrade rules[^\n]*/);
    assert.ok(okLine, 'the success line should still exist');
    assert.match(
      okLine[0],
      /\$written/,
      'a fixed "[ OK ] Upgrade rules synced" string is exactly what hid this bug'
    );
  });

  it('a target that throws is named rather than absorbed', () => {
    assert.match(content, /catch\s*\{[\s\S]{0,200}\$failed\s*\+=/);
    assert.match(content, /\[WARN\][^\n]*failed/);
  });

  it('a missing helper is reported rather than skipped in silence', () => {
    assert.match(content, /\[WARN\][^\n]*helper missing/);
  });
});
