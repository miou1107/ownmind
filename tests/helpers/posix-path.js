import path from 'node:path';

/**
 * A repo-relative path, spelled the way the assertion is written.
 *
 * v1.26.119 — several tests collect files by walking `src/` or `client/src/`, turn each hit
 * into a repo-relative path with `path.relative`, and compare the list against a literal like
 * `'src/app.js'`. On Windows `path.relative` answers `src\app.js`, so the comparison fails on
 * the separator while the thing being asserted — which file was found — is correct. The ruler
 * is wrong, not the product, and it is wrong on the one platform the CI leg runs on.
 *
 * Normalising at the point where a path becomes an assertion keeps the literals readable and
 * keeps the tests honest on every platform. It is deliberately not a general "compare paths
 * loosely" helper: a test that means to check a Windows path should say so.
 */
export function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

/** `path.relative`, in the spelling the assertions use. */
export function relPosix(from, to) {
  return toPosix(path.relative(from, to));
}
