import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

/**
 * A throwaway directory that is removed when the file that asked for it finishes.
 *
 * Every test that needs scratch space wrote its own `fs.mkdtempSync(path.join(os.tmpdir(), …))`
 * and then either removed it, or did not. Measured on 2026-08-13, the system temp directory
 * held 5264 leftover `ownmind-*` directories from eleven different prefixes, the oldest six
 * days old. An empty directory breaks nothing, so nothing ever failed and nobody was told.
 *
 * Removing the leftovers fixes one afternoon. Putting cleanup in one place, and making that
 * place the only way to get a temp directory, is what stops the next prefix from appearing —
 * see `no-unregistered-temp-dir.test.js`, which is the half of this change that has teeth.
 *
 * `await tempDir('x-')` is deliberately valid: the call sites this replaced were a mix of
 * `mkdtempSync` and `await fsp.mkdtemp`, and awaiting a string resolves it unchanged, so the
 * async ones did not have to be rewritten into a different shape to be converted.
 */

const created = [];

export function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * Exported so a test can prove the cleanup happened rather than trusting that it was
 * registered. Removing a directory twice is not an error — `force` makes the second call a
 * no-op — so files that already had their own cleanup keep it and lose nothing.
 */
export function cleanupTempDirs() {
  const failures = [];
  for (const dir of created) {
    try {
      // Retries, because on Windows a directory a test served over HTTP is routinely still
      // held for a moment after the server is done with it, and the rmdir comes back
      // ENOTEMPTY. Measured on CI 2026-08-16. Tolerating the failure was already the policy
      // here; retrying is what makes the directory actually go, rather than accumulating the
      // leftovers this module was written to stop.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (err) {
      failures.push(`${dir}: ${err.message}`);
    }
  }
  created.length = 0;
  return failures;
}

// Registered at import time, which makes it a file-level hook in the process running the file
// that imported this. Not thrown on failure: a single file locked by a child process on
// Windows should not turn a green suite red. Written to stderr, because a cleanup that fails
// silently restores the exact situation this module exists to end.
after(() => {
  const failures = cleanupTempDirs();
  for (const line of failures) {
    process.stderr.write(`could not remove temp dir ${line}\n`);
  }
});
