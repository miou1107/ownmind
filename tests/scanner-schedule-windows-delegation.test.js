import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { tempDir } from './helpers/temp-dir.js';

/**
 * On Windows, the daily auto-update repairs the scanner's schedule.
 *
 * `ensure-scanner-schedule.sh` opens with the incident it was written for: a collector that
 * stopped for three weeks because only its scheduled task had died, and the observation that
 * the Windows repair "never reached him: only bootstrap.ps1 calls it, and nobody runs
 * bootstrap by hand. Repair has to live on the road the failure travels, which is the daily
 * auto-update."
 *
 * The daily auto-update on Windows is `bash update.sh` — the command the server hands out in
 * `upgrade_action.command`, which Git Bash runs. It called this script, matched no OS branch,
 * printed `OK:schedule:skipped_unsupported_os`, and update.sh went on to print
 * "[ OK ] Usage scanner ready" for a schedule nothing had looked at. Measured 2026-08-15:
 * the fix for the incident had never been connected to the platform the incident happened on.
 *
 * These tests drive the delegation with a stub interpreter, via `OWNMIND_PWSH`. Deleting the
 * developer's own scheduled task to watch it come back is not a test.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const SCRIPT = path.join(repoRoot, 'scripts', 'install-helpers', 'ensure-scanner-schedule.sh');

/**
 * A stubbed OWNMIND_DIR carrying a fake PowerShell helper, plus a stub interpreter that
 * prints `output` and exits `code` no matter what it is handed.
 */
function stage({ output, code = 0, withHelper = true }) {
  const dir = tempDir('ownmind-sched-deleg-');
  const helpers = path.join(dir, 'scripts', 'install-helpers');
  fs.mkdirSync(helpers, { recursive: true });
  if (withHelper) {
    fs.writeFileSync(path.join(helpers, 'ensure-scanner-schedule.ps1'), '# stub\n');
  }

  const pwsh = path.join(dir, 'stub-pwsh.sh');
  fs.writeFileSync(pwsh, `#!/bin/sh\ncat <<'STUB_EOF'\n${output}\nSTUB_EOF\nexit ${code}\n`, { mode: 0o755 });
  return { dir, pwsh };
}

function run({ dir, pwsh }) {
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OWNMIND_OS: 'msys',
      OWNMIND_DIR: dir,
      // The path alone. `OWNMIND_PWSH` is expanded unquoted into the command position, so a
      // value carrying arguments would be looked up as one long executable name.
      OWNMIND_PWSH: pwsh,
    },
  });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

describe('the Windows branch delegates instead of declaring the OS unsupported', () => {
  it('never reports skipped_unsupported_os on Windows', () => {
    const staged = stage({ output: 'OK:schedule:already_registered' });
    const r = run(staged);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /skipped_unsupported_os/,
      'this is the exact line that let a dead schedule pass as "Usage scanner ready"');
  });

  it('passes the helper\'s verdict through unchanged', () => {
    const staged = stage({ output: 'OK:schedule:repaired' });
    const r = run(staged);
    assert.equal(r.stdout, 'OK:schedule:repaired');
    assert.equal(r.status, 0);
  });

  it('passes a failure through as a failure', () => {
    // The caller reads the exit code. A repair that could not happen must not exit 0, or the
    // update prints "ready" over it — which is the whole defect, one layer down.
    const staged = stage({ output: 'ERROR:schedule:task absent after re-registering', code: 1 });
    const r = run(staged);
    assert.match(r.stdout, /^ERROR:schedule:/);
    assert.equal(r.status, 1);
  });

  it('treats an unreadable answer as an error, not as an OK', () => {
    // A helper that crashed, or printed a PowerShell stack trace, says nothing this script can
    // read. "I could not tell" and "it is fine" are different facts and only one of them is
    // safe to print.
    const staged = stage({ output: 'Unhandled exception: something went very wrong', code: 0 });
    const r = run(staged);
    assert.match(`${r.stdout}${r.stderr}`, /ERROR:schedule:/);
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}${r.stderr}`, /something went very wrong/,
      'the helper\'s own words are the only thing that makes this actionable — keep them');
  });

  it('says so when the helper is missing rather than skipping quietly', () => {
    const staged = stage({ output: 'unused', withHelper: false });
    const r = run(staged);
    assert.match(`${r.stdout}${r.stderr}`, /ERROR:schedule:/);
    assert.notEqual(r.status, 0);
  });

  it('leaves genuinely unsupported platforms alone', () => {
    const staged = stage({ output: 'unused' });
    const r = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, OWNMIND_OS: 'freebsd12', OWNMIND_DIR: staged.dir },
    });
    assert.equal((r.stdout || '').trim(), 'OK:schedule:skipped_unsupported_os');
    assert.equal(r.status, 0);
  });
});
