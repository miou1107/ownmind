import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * v1.26.98 — review findings on the rollback-honesty change.
 *
 * The change itself is right: a rollback that failed used to be followed by "backup
 * restored", to the user and to the server. These cover the four things a review of it
 * turned up, each of which was reproduced before being fixed.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const shellScript = path.join(repoRoot, 'scripts', 'interactive-upgrade.sh');
const ps1Script = path.join(repoRoot, 'scripts', 'interactive-upgrade.ps1');
const reportSh = path.join(repoRoot, 'scripts', 'install-helpers', 'report-error.sh');
const reportPs1 = path.join(repoRoot, 'scripts', 'install-helpers', 'report-error.ps1');
const reportCjs = path.join(repoRoot, 'scripts', 'install-helpers', 'report-error.cjs');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-rollback-'));
}

function shellFunction(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf(`${name}() {`);
  assert.ok(start > 0, `${path.basename(file)} does not define ${name}()`);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, `${name}() has no closing brace at column 0`);
  return src.slice(start, end + 3);
}

describe('v1.26.98 — the worst rollback failure can still report itself', () => {
  /**
   * Rollback is delete-then-move. When the delete succeeds and the move does not, the
   * installation is gone — and the error reporter lives inside the directory that was just
   * deleted. Before this fix `report_error` found no helper, returned 0, and wrote nothing,
   * so the caller believed it had reported and the server heard nothing about the one
   * failure that destroys an install.
   */
  function callReportError(home, { helperOverride } = {}) {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    if (helperOverride) env.OWNMIND_REPORT_HELPER = helperOverride;
    execFileSync('bash', ['-c', [
      `. ${JSON.stringify(reportSh)}`,
      'report_error "upgrade_rollback_failed" "Rollback failed" ""',
    ].join('\n')], { env, stdio: ['ignore', 'ignore', 'ignore'] });
    const dir = path.join(home, '.ownmind', 'logs', 'errors');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }

  /** A HOME containing an install, with the reporter where it normally lives. */
  function makeHome() {
    const home = tmpdir();
    const helpers = path.join(home, '.ownmind', 'scripts', 'install-helpers');
    fs.mkdirSync(helpers, { recursive: true });
    fs.copyFileSync(reportCjs, path.join(helpers, 'report-error.cjs'));
    return home;
  }

  it('reports normally while the install is intact (positive control)', () => {
    // Without this, the assertions below pass just as well against a reporter that never
    // works at all.
    const home = makeHome();
    try {
      assert.equal(callReportError(home).length, 1, 'the baseline reporter wrote nothing');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('still reports after rollback has deleted the install', () => {
    const home = makeHome();
    try {
      // Stash a copy outside ~/.ownmind, the way the upgrade script now does.
      const stash = path.join(home, '.ownmind-logs');
      fs.mkdirSync(stash, { recursive: true });
      fs.copyFileSync(reportCjs, path.join(stash, 'report-error.cjs'));

      fs.rmSync(path.join(home, '.ownmind'), { recursive: true, force: true });

      const written = callReportError(home, { helperOverride: path.join(stash, 'report-error.cjs') });
      assert.equal(written.length, 1,
        'the install was destroyed and nothing was reported — the failure that matters most is invisible');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls back to the normal location when no override is set', () => {
    const home = makeHome();
    try {
      assert.equal(callReportError(home, { helperOverride: '/nonexistent/report-error.cjs' }).length, 1,
        'a stale override must not disable reporting');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('both upgrade scripts stash a copy and point the helper at it', () => {
    // Assert the assignment, not the mere presence of the name: renaming the variable to
    // something inert leaves the string in the file and would slip past a substring check.
    assert.match(fs.readFileSync(shellScript, 'utf8'),
      /OWNMIND_REPORT_HELPER="\$\{LOG_DIR\}\/report-error\.cjs"[\s\S]{0,120}export OWNMIND_REPORT_HELPER/,
      'the shell script does not export a reporter path outside the directory rollback deletes');
    assert.match(fs.readFileSync(ps1Script, 'utf8'),
      /\$env:OWNMIND_REPORT_HELPER = Join-Path \$LogDir "report-error\.cjs"/,
      'the PowerShell script does not set a reporter path outside the directory rollback deletes');
    for (const [name, src] of [['sh', fs.readFileSync(reportSh, 'utf8')],
                               ['ps1', fs.readFileSync(reportPs1, 'utf8')]]) {
      assert.ok(src.includes('OWNMIND_REPORT_HELPER'), `report-error.${name} ignores the override`);
    }
  });
});

describe('v1.26.98 — a rollback failure is diagnosed from its own error', () => {
  /**
   * `is_file_lock_error` reads a file. Pointed at the shared upgrade log it sees everything
   * earlier steps wrote, so an EACCES that `npm install` logged minutes ago makes an
   * unrelated rollback failure report itself as file-locked — and the user is told to close
   * Claude Code to fix a full disk.
   */
  const fn = () => shellFunction(shellScript, 'is_file_lock_error');

  function matches(contents) {
    const dir = tmpdir();
    try {
      const log = path.join(dir, 'log');
      fs.writeFileSync(log, contents);
      const out = execFileSync('bash', ['-c',
        `${fn()}\nif is_file_lock_error ${JSON.stringify(log)}; then echo YES; else echo NO; fi`,
      ], { encoding: 'utf8' });
      return out.trim() === 'YES';
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('recognises a lock in the text it is given', () => {
    assert.equal(matches("Cannot remove the item at 'C:\\x' because it is in use.\n"), true);
  });

  it('does not invent one where there is none (negative control)', () => {
    assert.equal(matches('rm: cannot remove: Directory not empty\n'), false);
  });

  it('the rollback path tests its own attempt, not the shared log', () => {
    const src = shellFunction(shellScript, 'rollback');
    assert.match(src, /is_file_lock_error "\$\{ROLLBACK_LOG\}"/,
      'reading the shared log makes an earlier npm failure decide this diagnosis');
    assert.ok(!/is_file_lock_error "\$\{LOG_FILE\}"/.test(src));
  });
});

describe('v1.26.98 — a failure message stays on one line', () => {
  /**
   * The header of both scripts documents the contract: the caller reads stdout line by line
   * for `INFO:` / `OK:` / `ERROR:<code>:<message>`. git output is several lines, and on
   * Windows `2>&1` yields ErrorRecord objects that render across even more. Interpolating
   * that into an ERROR line breaks the parser.
   */
  function oneLineTail(contents) {
    const dir = tmpdir();
    try {
      const f = path.join(dir, 'f');
      if (contents !== null) fs.writeFileSync(f, contents);
      return execFileSync('bash', ['-c', [
        'REASON_CHARS=300',
        shellFunction(shellScript, 'last_log_lines'),
        `last_log_lines ${JSON.stringify(f)}`,
      ].join('\n')], { encoding: 'utf8' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('folds several lines into one, keeping them separated', () => {
    const out = oneLineTail('first line\nsecond line\nthird line\n');
    assert.equal(out.includes('\n'), false, 'a newline here breaks the caller\'s line parser');
    // Separated, not glued: deleting the newlines alone would run the last word of one line
    // into the first of the next and make the message harder to read than the guess it
    // replaced. This is also what distinguishes folding from the cap's trailing cleanup —
    // without it, removing the fold changes nothing any assertion can see.
    assert.match(out, /second line\|third line/);
  });

  it('strips control characters, not only newlines', () => {
    // Windows git writes CR, and a tab or escape sequence reaches the same ERROR line.
    const out = oneLineTail('before\u0001\u001b[31m\rafter\n');
    // eslint-disable-next-line no-control-regex
    assert.equal(/[\u0000-\u001f]/.test(out), false, `control characters survived: ${JSON.stringify(out)}`);
  });

  it('caps a runaway message', () => {
    assert.ok(oneLineTail(`${'x'.repeat(4000)}\n`).length <= 300);
  });

  it('says so when there is nothing to read, rather than going blank', () => {
    assert.match(oneLineTail(null), /no log file|log empty/);
    assert.match(oneLineTail(''), /no log file|log empty/);
  });

  it('the PowerShell side normalises too, at the same cap', () => {
    const ps1 = fs.readFileSync(ps1Script, 'utf8');
    const sh = fs.readFileSync(shellScript, 'utf8');
    assert.match(ps1, /function ConvertTo-OneLine/);
    // ErrorRecord objects render multi-line through Out-String; ToString gives the message.
    assert.match(ps1, /ForEach-Object \{ \$_\.ToString\(\) \}/,
      'Out-String renders an ErrorRecord across several lines');
    // One cap per side, shared by every reason string — not one per feature.
    assert.match(ps1, /\$script:ReasonMaxChars = 300\b/);
    assert.match(sh, /REASON_CHARS=300\b/);
  });
});

describe('v1.26.98 — the rest of the review', () => {
  const sh = fs.readFileSync(shellScript, 'utf8');
  const ps1 = fs.readFileSync(ps1Script, 'utf8');

  it('git status failure carries git\'s own words, not just an exit code', () => {
    assert.match(sh, /upgrade_git_status_failed[\s\S]{0,200}last_log_lines/);
    assert.match(ps1, /upgrade_git_status_failed[\s\S]{0,200}\$statusSaid/);
  });

  it('the PowerShell side still creates the directory the beacon spools into', () => {
    // Moving $LogDir out of $OwnMindDir took the New-Item that made $OwnMindDir\logs, and
    // AppendAllText throws rather than creating a missing parent.
    assert.ok(ps1.includes('Join-Path $OwnMindDir "logs"'),
      'the upgrade-complete beacon spools into a directory nothing creates');
    assert.match(sh, /mkdir -p "\$\{OWNMIND_DIR\}\/logs"/);
  });

  it('neither side duplicates the git-pull detail that PR #59 supplies', () => {
    // Two copies of the same fix in one release collide for no gain.
    for (const [name, src] of [['sh', sh], ['ps1', ps1]]) {
      assert.ok(!/GIT_SAID|\$gitSaid/.test(src), `${name} still carries the duplicated version`);
    }
    // But the Windows-only half — writing the output to the log at all — must stay.
    assert.match(ps1, /\$pullOut \| Out-File -Append \$LogFile/);
  });
});
