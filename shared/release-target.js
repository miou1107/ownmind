/**
 * shared/release-target.js: which commit an installed machine should update to.
 *
 * Until v1.30.48 every automatic update moved ~/.ownmind to the tip of GitHub's main branch,
 * the moment anything landed there: a commit pushed between a fix and its release, a merge
 * still being checked, a push made by mistake. Each was on every machine by the next
 * session. Updates now go to the newest release tag (vX.Y.Z) instead, which is the version
 * somebody chose to ship, and only to a tag that is part of main's history, so a tag left on
 * a side branch is not followed.
 *
 * This does not prove who made the release. Somebody who controls the GitHub account can
 * tag too; that needs signed tags, which were decided against on 2026-10-03.
 */

export const RELEASE_TAG = /^v(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** Release tags among `lines`, newest first. Anything not exactly vX.Y.Z is ignored. */
export function sortReleaseTags(lines) {
  return String(lines || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => RELEASE_TAG.test(s))
    .map((tag) => ({ tag, parts: tag.match(RELEASE_TAG).slice(1).map(Number) }))
    .sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2])
    .map((t) => t.tag);
}

/**
 * Fetch main and the release tags, letting the remote's tags win.
 *
 * `--force`: a tag moved or re-created on GitHub otherwise makes every later fetch fail
 * ("would clobber existing tag"), and updates stop on every machine for good. `--prune
 * --prune-tags`: a tag deleted on GitHub (pushed by mistake) is deleted here too, or a
 * machine would keep treating it as the newest release forever. --prune-tags needs git 2.17;
 * older git retries without the pruning rather than failing.
 *
 * @returns {Promise<void>} rejects when even the plain fetch fails (offline, no access)
 */
export async function fetchReleases({ execFile, cwd, timeout = 30_000 }) {
  try {
    await execFile('git', ['fetch', '-q', '--force', '--prune', '--prune-tags', 'origin'], { cwd, timeout });
  } catch {
    await execFile('git', ['fetch', '-q', '--force', '--tags', 'origin'], { cwd, timeout });
  }
}

/**
 * The newest release tag that is part of origin/main's history, or null.
 *
 * Expects the tags to have been fetched already (fetchReleases). Looks at the twenty
 * newest only: a newer tag that is not on main is skipped for an older one that is, but a
 * repository with no tag on main at all should not cost a git call per tag ever made.
 *
 * @param {object} deps
 * @param {Function} deps.execFile  promisified execFile(cmd, args, opts)
 * @param {string}   deps.cwd       the checkout
 * @param {number}   [deps.timeout]
 * @param {string}   [deps.branch]  remote branch the tag must be on
 * @returns {Promise<string|null>}
 */
export async function findReleaseTarget({ execFile, cwd, timeout = 10_000, branch = 'origin/main' }) {
  const { stdout } = await execFile('git', ['tag', '-l', 'v*'], { cwd, timeout });
  for (const tag of sortReleaseTags(stdout).slice(0, 20)) {
    try {
      await execFile('git', ['merge-base', '--is-ancestor', `refs/tags/${tag}`, branch], { cwd, timeout });
      return tag;
    } catch { /* not on main: try the next one */ }
  }
  return null;
}
