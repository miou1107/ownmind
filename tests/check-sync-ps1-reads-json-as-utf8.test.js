import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * bug-report id=30 — check-sync.ps1 called the rules cache unreadable on a machine where the
 * hooks were reading it without trouble.
 *
 * Windows PowerShell 5.1's `Get-Content` decodes by BOM if there is one and by the system ANSI
 * code page if there is not — cp950 on the Traditional Chinese Windows this was reported from.
 * The cache is BOM-less UTF-8, so the moment a memory carried a Chinese tag the decode mangled
 * it, some byte pairs swallowed a closing quote, ConvertFrom-Json threw, the silent catch left
 * L4 at `unreadable`, and OVERALL went to `needs_upgrade` on a machine that had nothing to
 * upgrade to. The same trap is documented at length in
 * scripts/windows/lib/append-upgrade-rule.ps1.
 *
 * These assertions read the script as text, and text is all they prove. check-sync.ps1 needs
 * PowerShell, which neither this machine nor this suite has, so the fixed script has NOT been
 * run against a cp950 machine with a Chinese-tagged cache — nobody should read a green suite
 * here as that having happened.
 *
 * The requirement being pinned is "JSON is decoded as UTF-8 whatever the machine's code page
 * is", not "do not call Get-Content": `Get-Content -Encoding UTF8` would satisfy it too, while
 * a two-line `$raw = Get-Content -Raw` followed by `$raw | ConvertFrom-Json` would not, and
 * that split is the likeliest way this comes back (install.ps1 already reads that way).
 */
describe('check-sync.ps1 — JSON is read as UTF-8, not as the system code page', () => {
  const lines = fs
    .readFileSync(path.join(repoRoot, 'scripts', 'check-sync.ps1'), 'utf8')
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }));

  /** A read on the same line whose encoding does not depend on the machine's code page. */
  const READS_AS_UTF8 =
    /Read-Utf8Text|\[System\.IO\.File\]::ReadAllText|Get-Content[^|]*-Encoding\s+UTF8/;

  const parses = lines.filter(({ text }) => /ConvertFrom-Json/.test(text) && !/^\s*#/.test(text));

  it('parses JSON in this script at all (the assertions below need something to check)', () => {
    assert.equal(parses.length, 3, 'expected the package.json, settings.json and cache reads');
  });

  it('every parse takes its text from a read that is UTF-8 whatever the code page is', () => {
    const offenders = parses.filter(({ text }) => !READS_AS_UTF8.test(text));
    assert.deepEqual(
      offenders.map(({ line, text }) => `${line}: ${text.trim()}`),
      [],
      'a ConvertFrom-Json whose input was not read as UTF-8 on the same line'
    );
  });

  it('the shared reader keeps the file open for sharing, as Get-Content did', () => {
    const reader = lines.find(({ text }) => /\[System\.IO\.File\]::Open\(/.test(text));
    assert.ok(reader, 'Read-Utf8Text should open the file itself');
    assert.match(
      reader.text,
      /\[System\.IO\.FileShare\]::ReadWrite/,
      'ReadAllText opens with FileShare::Read, so a read landing while the cache is being ' +
        'rewritten would throw — and that reads as the same `unreadable` this fix removes'
    );
  });
});
