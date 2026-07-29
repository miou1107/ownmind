/**
 * Version-floor comparison for the root-level dependencies that update.sh /
 * update.ps1 install onto user machines.
 *
 * Why this exists
 * ---------------
 * install.sh and interactive-upgrade.sh only run `npm install` inside
 * ~/.ownmind/mcp/. Root dependencies reach a user machine through exactly one
 * path: the explicit `npm install <pkg> --no-save` calls in scripts/update.sh.
 * Those calls used to be guarded by "does ~/.ownmind/node_modules/<pkg> exist?",
 * so once a package was present it was never looked at again.
 *
 * That guard is why js-yaml sat at 4.1.1 on machines carrying CVE-2026-59869.
 * Note that the install command itself was never the problem: `npm install
 * js-yaml@^4.1.1` re-resolves against the registry and installs 4.3.0 even when
 * the lockfile pins 4.1.1. The command would have delivered the patch; the guard
 * never let it run.
 *
 * Guarding on the installed version instead means raising the floor in
 * update.sh / update.ps1 is enough to push the upgrade out on the next sync.
 *
 * Everything unreadable — missing package, absent version field, broken JSON,
 * unparseable input — reports "floor not met", because the consequence is a
 * redundant `npm install` (idempotent) rather than a vulnerable copy left in
 * place.
 *
 * This module is pure: it holds no CLI block, so importing it never runs
 * anything. The shell-facing predicate lives in dep-floor-cli.mjs, which always
 * runs when executed. Keeping those apart removes a whole failure class — a
 * self-detecting CLI (`process.argv[1] === import.meta.url`) silently does
 * nothing when the invocation path differs from the module's realpath, which
 * happens whenever any component is a symlink, and "did nothing" would exit 0
 * and be read as "floor met".
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Split a semver string into a numeric triple plus a prerelease flag.
 *
 * Build metadata (`+sha`) is ignored; a prerelease suffix (`-rc.1`) is recorded
 * because it ranks below the release of the same triple.
 *
 * @param {unknown} raw
 * @returns {{ core: [number, number, number], pre: boolean } | null}
 */
export function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]*))?(?:\+.*)?$/.exec(raw.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] !== undefined,
  };
}

/**
 * Is `installed` at or above `floor`?
 *
 * Not full semver ordering: two prereleases of the same triple compare equal,
 * so `4.3.0-rc.1` counts as meeting a floor of `4.3.0-rc.2`. Floors here are
 * always release versions, so that case does not arise; the only prerelease
 * rule that matters is that a prerelease does not reach its own release.
 *
 * @param {unknown} installed
 * @param {unknown} floor
 * @returns {boolean} false whenever either side cannot be read (fail safe)
 */
export function satisfiesFloor(installed, floor) {
  const have = parseVersion(installed);
  const want = parseVersion(floor);
  if (!have || !want) return false;

  for (let i = 0; i < 3; i += 1) {
    if (have.core[i] > want.core[i]) return true;
    if (have.core[i] < want.core[i]) return false;
  }

  // Same triple: a prerelease of the wanted release does not count as reaching it.
  return !(have.pre && !want.pre);
}

/**
 * Read the version of a package installed under `<ownmindDir>/node_modules`.
 *
 * @param {string} ownmindDir
 * @param {string} pkg  bare or scoped name, e.g. "js-yaml" or "@hono/node-server"
 * @returns {string | null} null when absent or unreadable
 */
export function readInstalledVersion(ownmindDir, pkg) {
  try {
    const manifest = join(ownmindDir, 'node_modules', ...pkg.split('/'), 'package.json');
    const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}
