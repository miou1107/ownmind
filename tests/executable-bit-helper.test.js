import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExecutable } from './helpers/executable-bit.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * v1.26.118 — the ruler that replaced `statSync(f).mode & 0o100` needs its own reverse
 * control, or "it passes on Windows now" is indistinguishable from "it passes on anything".
 */
describe('v1.26.118 — the executable-bit ruler works on every platform', () => {
  it('passes for a script committed as 100755', () => {
    assertExecutable(repoRoot, 'scripts/bootstrap.sh');
  });

  it('positive control: a file committed as 100644 fails', () => {
    // README.md is tracked and must never be executable. If this ever stops throwing, the
    // assertion above has stopped measuring anything.
    assert.throws(() => assertExecutable(repoRoot, 'README.md'), /100644/);
  });

  it('an untracked path fails rather than passing silently', () => {
    // The failure mode that would make the whole helper worthless on a checkout where the
    // path moved: `git ls-files` prints nothing, and nothing is not a pass.
    assert.throws(() => assertExecutable(repoRoot, 'scripts/no-such-script-here.sh'),
      /does not exist/);
  });
});
