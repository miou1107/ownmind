import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Assert that a tracked script will be executable wherever it is checked out.
 *
 * v1.26.118 — `statSync(f).mode & 0o100` cannot pass on Windows. chmod is a no-op on NTFS:
 * measured on TANK, a file chmod'ed to 755 reads back as 666. So two shipping scripts were
 * reported broken by a ruler that cannot measure on that platform — the ruler is what is
 * wrong, not the product.
 *
 * Skipping the assertion there would leave Windows with no answer at all, which is the
 * failure mode this repository keeps rediscovering: a test that is green on macOS and absent
 * on Windows is not a passing test, it is an invisible one (v1.26.106).
 *
 * The index mode is the better question anyway, on every platform. The filesystem bit
 * describes what one machine happens to have right now; `100755` in git is what every other
 * machine gets on checkout, and that is the property these tests exist to protect — a script
 * committed as 100644 is unrunnable for everybody who clones, whatever the author's own
 * working copy says. It is also the only one of the two that a Windows CI leg can read.
 *
 * The local bit is still asserted where it means something, so a POSIX machine that has
 * somehow lost it does not go quiet.
 */
export function assertExecutable(repoRoot, relPath) {
  const abs = path.join(repoRoot, relPath);
  assert.ok(fs.existsSync(abs), `${relPath} does not exist`);

  const gitPath = relPath.split(path.sep).join('/');
  const out = execFileSync('git', ['ls-files', '-s', '--', gitPath],
    { cwd: repoRoot, encoding: 'utf8' }).trim();
  assert.ok(out, `${gitPath} is not tracked by git, so its index mode cannot be read`);
  const mode = out.split(/\s+/)[0];
  assert.equal(mode, '100755',
    `${gitPath} is committed as ${mode}: it will not be executable on checkout. `
    + 'Fix with: git update-index --chmod=+x ' + gitPath);

  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(abs).mode & 0o100,
      `${relPath} is executable in the index but not in this working copy (chmod +x it)`);
  }
}
