import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The one hard guarantee: an edit to a path somebody else owns does not happen.
 *
 * Everything else in this feature raises the odds. This is the layer that does not, which
 * is why it decides from data it can check rather than from anything an assistant reports
 * about itself.
 *
 * The repo is resolved from the directory of the file being written, never from the
 * process's working directory. On 2026-08-13 the session ran inside one checkout while the
 * file at issue lived in another; a working-directory check would have waved that edit
 * through in its first step, and every test that passed the function a path would still
 * have been green.
 *
 * Guard entries are the flat shape the enforcement bundle ships - `{id, title, repo_match,
 * paths, owner}`. The nested `metadata.enforcement.guard` form belongs to the database row
 * and does not reach this machine, so reaching for it here would mean matching nothing in
 * production and everything in a test built from a hand-written row.
 */

const GIT_TIMEOUT_MS = 2000;

function gitLines(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GIT_TIMEOUT_MS,
  }).split('\n');
}

function git(dir, args) {
  return gitLines(dir, args).join('\n').trim();
}

/**
 * The nearest ancestor directory that exists, and the segments below it that do not.
 *
 * A file about to be created brings its folders with it: the first file under `ci/templates/`
 * is written before that directory exists. Asking git about a directory that is not there
 * gets an error, which used to read as "this file is in no repository" and allowed the write.
 * That is the ordinary way to add a file under a guarded path, so the one hard guarantee had
 * a hole in it wide enough to walk through without trying.
 *
 * @returns {{dir: string, missing: string[]} | null} null only if nothing up to the root exists
 */
function nearestExistingDir(filePath) {
  let dir = path.dirname(path.resolve(filePath));
  const missing = [];
  // Terminates at the filesystem root, where `path.dirname(x) === x`.
  for (;;) {
    try {
      if (fs.statSync(dir).isDirectory()) return { dir, missing };
    } catch { /* not there yet - keep climbing */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    missing.unshift(path.basename(dir));
    dir = parent;
  }
}

/**
 * The repository the given file belongs to, and where the file sits inside it.
 *
 * `relPath` comes from git's own `--show-prefix` rather than from subtracting one path
 * string from another. Two spellings of one directory are both valid and neither realpath
 * nor `path.relative` reconciles them: on Windows `os.tmpdir()` answers `C:\Users\RUNNER~1\…`
 * while git answers `C:\Users\runneradmin\…`, and on a case-insensitive volume any difference
 * in case does the same. Subtracting those produced a path that climbed out of the repo, the
 * file read as somebody else's, and the guard allowed the edit — silently, which is the part
 * that matters. git computes the prefix from the directory it is standing in, so no spelling
 * enters the answer at all.
 *
 * @param {string} filePath absolute path of the file about to be written
 * @returns {{remote: string, root: string, relPath: string} | null} null outside a repo,
 *   or in a repo with no origin
 */
export function resolveRepo(filePath) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const nearest = nearestExistingDir(filePath);
  if (!nearest) return null;
  try {
    // No origin means nothing to compare `repo_match` against. Leaving such a repo alone is
    // deliberate: a guard that guessed would block edits in repositories it cannot identify.
    const remote = git(nearest.dir, ['remote', 'get-url', 'origin']);
    if (!remote) return null;
    // Two answers, one spawn. `--show-prefix` is the existing directory's path relative to
    // the root, forward-slashed and trailing-slashed, or empty at the root itself - so the
    // whole output cannot be trimmed as one string without losing that empty second line.
    const [rootLine = '', prefixLine = ''] = gitLines(nearest.dir, [
      'rev-parse', '--show-toplevel', '--show-prefix',
    ]);
    const root = rootLine.trim();
    if (!root) return null;
    const prefix = prefixLine.trim();
    const relPath = [
      prefix,
      ...nearest.missing.map((segment) => `${segment}/`),
    ].join('') + path.basename(path.resolve(filePath));
    return { remote, root, relPath };
  } catch {
    return null;
  }
}

/**
 * A deliberately small glob: `**` spans separators, `*` does not, and both ends are anchored.
 *
 * Anchoring is what keeps `ci/**` from matching `circle/config.yml`, and what keeps
 * `.gitlab-ci.yml` from matching `docs/.gitlab-ci.yml.md`.
 */
function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\/'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`${out}$`);
}

/**
 * @param {string} filePath the file the tool is about to write
 * @param {Array<object>} guards flat guard entries from the enforcement bundle
 * @returns {{standard: object, matchedPath: string, relPath: string} | null}
 */
export function findGuardViolation(filePath, guards) {
  if (!Array.isArray(guards) || guards.length === 0) return null;
  const repo = resolveRepo(filePath);
  if (!repo || !repo.relPath) return null;

  const { relPath } = repo;

  for (const guard of guards) {
    if (!guard || !Array.isArray(guard.paths)) continue;
    if (guard.repo_match && !repo.remote.includes(guard.repo_match)) continue;
    for (const pattern of guard.paths) {
      if (typeof pattern !== 'string' || !pattern) continue;
      if (globToRegExp(pattern).test(relPath)) {
        return { standard: guard, matchedPath: pattern, relPath };
      }
    }
  }
  return null;
}

/**
 * The text about to be written, checked for a forbidden path by name.
 *
 * The 2026-08-13 incident produced a plan document at a perfectly legal path whose contents
 * proposed the forbidden edit. A guard that only reads `file_path` waves that through, and
 * the damage - a person reading a plan built on a rule the assistant had already broken -
 * is done before any edit to the guarded file is ever attempted.
 *
 * Deliberately narrow: a literal path segment, not a pattern. Anything looser would fire on
 * a document quoting the standard in order to comply with it.
 *
 * @returns {{standard: object, matchedPath: string} | null}
 */
export function findContentMention(content, guards) {
  if (typeof content !== 'string' || !content) return null;
  if (!Array.isArray(guards)) return null;

  for (const guard of guards) {
    if (!guard || !Array.isArray(guard.paths)) continue;
    for (const pattern of guard.paths) {
      if (typeof pattern !== 'string') continue;
      // `ci/**` becomes `ci/`. The trailing slash is kept on purpose: it is what makes the
      // literal specific enough to be worth matching, and stripping it once left `ci`, which
      // is both too short to survive the length check and too generic to be safe if it had.
      const literal = pattern.replace(/\*+/g, '');
      if (literal.length >= 3 && content.includes(literal)) {
        return { standard: guard, matchedPath: pattern };
      }
    }
  }
  return null;
}

/**
 * What the assistant is told when it is blocked.
 *
 * It says what to do instead, because a block with no next step gets worked around rather
 * than obeyed. It also names the claim that caused the incident - a permissions list inside
 * the repo appearing to grant access the standard withholds - since that file is right
 * there, and the assistant read it last time.
 */
export function formatGuardBlock(violation) {
  const standard = violation?.standard || {};
  const owner = standard.owner || 'the owner of this path';
  const isTeam = standard.type === 'team_standard';
  const lines = [
    `[OwnMind] Blocked by ${isTeam ? 'team standard' : 'rule'} ${standard.id}: ${standard.title || ''}`,
    `  ${violation.relPath} is not yours to edit (pattern: ${violation.matchedPath}).`,
    `  It belongs to ${owner}. This holds for every engineer, including anyone listed as an`,
    '  admin in a file inside this repository: the rule outranks the repository.',
  ];
  // The same distinction the injected precedence sentence makes, and it has to be the same
  // here or the assistant hears one story up front and a different one when it is stopped.
  // A team standard protects somebody else's work, so the person at the keyboard saying it
  // is fine does not settle it.
  if (isTeam) {
    lines.push(
      '  This is a team standard, not one of the user\'s own rules: their say-so does not',
      '  waive it. If they want it overridden anyway, ask them to reply with 「確認」 first.',
    );
  }
  lines.push(`  What to do instead: open an issue for ${owner} describing the change you need.`);
  // The person at the keyboard sees nothing when a tool call is denied — the harness prints
  // one generic line and keeps the rest. So the only way this reaches them is if the
  // assistant says it, which means the message has to ask. Its sibling in
  // ownmind-edit-reminder.js (the content-mention warning) has always asked; this one, the
  // harder block of the two, did not.
  lines.push('  Tell the user this, in the language you are speaking with them.');
  return lines.join('\n');
}
