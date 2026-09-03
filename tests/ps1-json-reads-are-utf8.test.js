import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Follow-up to bug-report id=30: the same decode fault, in the scripts that write.
 *
 * Windows PowerShell 5.1's `Get-Content` decodes by BOM if there is one and by the system ANSI
 * code page if there is not — cp950 on Traditional Chinese Windows. bug-report 30 was
 * check-sync.ps1 reading the rules cache that way and calling a healthy machine out of date.
 * The installer does something worse with the same read: install.ps1 reads
 * ~/.claude/settings.json, adds the MCP entry to the object, and writes the whole thing back.
 * Read as cp950, every non-ASCII character in that file is replaced on the way out — and the
 * installer puts a Chinese Windows username into it itself, through the `start.cmd` path in
 * the MCP args.
 *
 * The rule pinned here: a PowerShell read that takes a file as one value — `-Raw`, `-First`,
 * `-TotalCount` — says which encoding it expects. Those are the reads whose result is parsed,
 * compared or written back, so a wrong guess corrupts something. Reads that walk a file line by
 * line are left alone on purpose: interactive-upgrade.ps1 tails logs that PowerShell 5.1 itself
 * wrote in UTF-16LE, and demanding UTF-8 there would be the same mistake pointing the other way.
 *
 * Three remedies for this one hazard now live in the tree, and each is right where it is:
 * `[System.IO.File]::ReadAllText` in append-upgrade-rule.ps1, a `Read-Utf8Text` helper in
 * check-sync.ps1, and plain `-Encoding UTF8` here. The reason this file's call sites need
 * neither of the first two is that they are still on `Get-Content`, which opens the file
 * `FileShare::ReadWrite` — `ReadAllText` opens `FileShare::Read`, and the helper exists to hand
 * that back. Anyone unifying the three should unify towards the flag, not away from it.
 *
 * These assertions read the scripts as text, and text is all they prove. None of these scripts
 * can run here — this suite has no PowerShell at all — so nothing below demonstrates the
 * behaviour on a cp950 machine.
 */

// scripts/check-sync.ps1 is excluded while the bug-report 30 fix is still on its own branch
// (fix/bug-report-30-check-sync-utf8), where its reads move to a Read-Utf8Text helper and are
// pinned by tests/check-sync-ps1-reads-json-as-utf8.test.js. Once that merges the file has no
// whole-file Get-Content left, so this entry should simply be deleted rather than adjusted.
const EXCLUDED = new Set(['scripts/check-sync.ps1']);

/** Every PowerShell script shipped from this repo. */
function shippedScripts(dir = repoRoot, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) shippedScripts(full, found);
    else if (entry.name.endsWith('.ps1')) found.push(path.relative(repoRoot, full));
  }
  return found;
}

/**
 * The reads to check, as {line, read} where `read` is only the Get-Content call itself — a
 * later `| Out-File -Encoding UTF8` in the same pipeline says nothing about how the file came in.
 */
function wholeFileReads(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const at = line.indexOf('Get-Content');
    if (at === -1) return;
    const rest = line.slice(at);
    const pipe = rest.indexOf('|');
    const read = pipe === -1 ? rest : rest.slice(0, pipe);
    if (/\s-(Raw|First|TotalCount)\b/.test(read)) out.push({ line: i + 1, read: read.trim() });
  });
  return out;
}

describe('shipped PowerShell — a whole-file read says which encoding it expects', () => {
  const scripts = shippedScripts().filter((rel) => !EXCLUDED.has(rel));

  it('finds the scripts to check, so the assertions below are not vacuous', () => {
    assert.ok(scripts.includes('install.ps1'), 'install.ps1 should be in the scan');
    assert.ok(scripts.length >= 6, `only ${scripts.length} PowerShell scripts found`);
    const reads = scripts.flatMap((rel) =>
      wholeFileReads(fs.readFileSync(path.join(repoRoot, rel), 'utf8'))
    );
    assert.ok(reads.length >= 9, `only ${reads.length} whole-file reads found across the scan`);
  });

  for (const rel of shippedScripts().filter((r) => !EXCLUDED.has(r))) {
    it(`${rel}: every whole-file read asks for UTF-8`, () => {
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      const offenders = wholeFileReads(text)
        .filter(({ read }) => !/-Encoding\s+UTF8/i.test(read))
        .map(({ line, read }) => `${line}: ${read}`);
      assert.deepEqual(
        offenders,
        [],
        'without -Encoding UTF8, Windows PowerShell 5.1 decodes a BOM-less file by the ' +
          "machine's ANSI code page"
      );
    });
  }
});
