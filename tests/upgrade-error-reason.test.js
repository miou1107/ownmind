import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

/**
 * v1.26.98 — an upgrade failure has to say what actually went wrong.
 *
 * Every `report_error` call in the upgrade scripts passed a hand-written guess as its
 * `detail`, and `detail` is what reaches the server, the admin console and the health
 * broadcast:
 *
 *     "git pull --ff-only failed (network or non-ff merge)"
 *
 * That is the same sentence whether the remote was unreachable, the branch had diverged, or
 * a file was locked. On 2026-08-07 DESKTOP-8DD75VJ failed a pull, restored its backup and
 * came back healthy seven seconds later — and there was no way to say why it had failed,
 * because the guess was the only record of it.
 *
 * git's real output was already being appended to the log file, and the log file was already
 * being passed as the context argument. The report still arrived with `context: ""`. Where
 * that is lost is not established — there is no Windows machine here to reproduce it on, and
 * a cause we cannot demonstrate is not one to write down. `detail` is a plain string that is
 * known to arrive, so the reason now goes there as well.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const shellScript = path.join(repoRoot, 'scripts', 'interactive-upgrade.sh');
const ps1Script = path.join(repoRoot, 'scripts', 'interactive-upgrade.ps1');

/** Extract a shell function by name so the test runs what ships. */
function shellFunction(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf(`${name}() {`);
  assert.ok(start > 0, `${path.basename(file)} does not define ${name}()`);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, `${name}() has no closing brace at column 0`);
  return src.slice(start, end + 3);
}

/** Run `last_log_lines` against a log file whose contents we control. */
function lastLogLines(contents) {
  const dir = tempDir('ownmind-reason-');
  try {
    const log = path.join(dir, 'upgrade.log');
    if (contents !== null) fs.writeFileSync(log, contents);
    return execFileSync('bash', ['-c', [
      'REASON_CHARS=300',
      shellFunction(shellScript, 'last_log_lines'),
      `last_log_lines ${JSON.stringify(log)}`,
    ].join('\n')], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('v1.26.98 — the reason survives into the detail field', () => {
  it('reports what git actually said', () => {
    // The message a diverged branch produces. This is the sentence that was missing.
    const gitSaid = 'fatal: Not possible to fast-forward, aborting.';
    const out = lastLogLines(`Updating 1234567..89abcde\n${gitSaid}\n`);
    assert.ok(out.includes(gitSaid), `the reason was dropped: ${JSON.stringify(out)}`);
  });

  it('keeps it to one line', () => {
    // A newline in this value produces a line that is not valid JSON, and the whole report
    // is rejected on arrival — the silent loss the v1.26.95 hook work already ran into.
    const out = lastLogLines('line one\nline two\nline three\n');
    assert.equal(out.includes('\n'), false, 'a newline here loses the entire report');
    assert.ok(out.includes('line two') && out.includes('line three'));
  });

  it('strips control characters, not just newlines', () => {
    const out = lastLogLines('before\u0000\u0001\u001bafter\n');
    // eslint-disable-next-line no-control-regex
    assert.equal(/[\u0000-\u001f]/.test(out), false, `control characters left in: ${JSON.stringify(out)}`);
  });

  it('is capped, so a runaway log cannot blow up the report', () => {
    const out = lastLogLines(`${'x'.repeat(5000)}\n`);
    assert.ok(out.length <= 300, `detail reason was ${out.length} characters`);
  });

  it('says so plainly when there is no log, rather than going blank', () => {
    // A blank reason reads as "no reason recorded", which is the state being fixed.
    assert.match(lastLogLines(null), /no log file/);
    assert.match(lastLogLines(''), /log empty/);
  });

  it('takes the end of the log, where the error is', () => {
    const out = lastLogLines(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'fatal: the real error'].join('\n'));
    assert.ok(out.includes('fatal: the real error'));
    assert.equal(out.includes('a|b'), false, 'took the head of the log instead of the tail');
  });
});

describe('v1.26.98 — every failure path carries it', () => {
  const sh = fs.readFileSync(shellScript, 'utf8');
  const ps1 = fs.readFileSync(ps1Script, 'utf8');

  it('no report_error in the shell script passes a bare guess', () => {
    // Derived from the file rather than listed here: a written list does not report the call
    // site it is missing, which is how the last one came to be the only uncovered hook.
    const calls = sh.match(/report_error "[^"]+" "[^"]*"/g) || [];
    assert.ok(calls.length >= 5, `only found ${calls.length} report_error calls — is the scan working?`);
    const withoutReason = calls.filter((c) => !c.includes('last_log_lines'));
    assert.deepEqual(withoutReason, [], 'these report a guess with no record of what happened');
  });

  it('no Report-Error in the PowerShell script passes a bare guess', () => {
    // Two normalisers, because there are two kinds of source: `Get-LastLogLines` reads the tail
    // of a log file, `ConvertTo-OneLine` folds an exception or captured output already in
    // memory. The requirement is that the Detail carries what actually happened, not that it
    // calls one particular function — asserting the narrower thing failed the rollback and
    // git-status reports, which do carry a real reason, by the other route.
    const calls = ps1.match(/Report-Error -Kind "[^"]+" -Detail "[^"]*"/g) || [];
    assert.ok(calls.length >= 5, `only found ${calls.length} Report-Error calls — is the scan working?`);
    const withoutReason = calls.filter((c) =>
      !c.includes('Get-LastLogLines') && !/\$\w*[Ss]aid|\$detail/.test(c));
    assert.deepEqual(withoutReason, [], 'these report a guess with no record of what happened');
  });

  it('the guess that started this is gone from what gets reported', () => {
    // Scoped to the reported strings, not the whole file: both scripts quote the old
    // sentence in a comment to record what was wrong with it, and that is worth keeping.
    const reported = [
      ...(sh.match(/report_error "[^"]+" "[^"]*"/g) || []),
      ...(ps1.match(/Report-Error -Kind "[^"]+" -Detail "[^"]*"/g) || []),
    ];
    const stillGuessing = reported.filter((c) => c.includes('network or non-ff merge'));
    assert.deepEqual(stillGuessing, [], 'still asserting a cause it cannot know');
  });

  it('both cap the reason at the same length', () => {
    // They feed the same field on the same server. A different cap per platform would make
    // the same failure read differently depending on the user's OS.
    assert.match(sh, /REASON_CHARS=300\b/);
    assert.match(ps1, /\$script:ReasonMaxChars = 300\b/);
  });

  it('the PowerShell helper is defined before anything calls it', () => {
    // PowerShell resolves at call time, so this is about the main flow, not the text order:
    // every Fail call must come after the definition.
    const defAt = ps1.indexOf('function Get-LastLogLines');
    assert.ok(defAt > 0, 'the helper is missing');
    const lines = ps1.split('\n');
    const defLine = ps1.slice(0, defAt).split('\n').length;
    lines.forEach((line, i) => {
      if (/^\s+Fail "/.test(line)) {
        assert.ok(i + 1 > defLine,
          `Fail is called on line ${i + 1}, before Get-LastLogLines is defined on line ${defLine}`);
      }
    });
  });
});
