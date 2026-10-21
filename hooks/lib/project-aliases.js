/**
 * hooks/lib/project-aliases.js — the names the current working directory answers to.
 *
 * v1.33.0: a pending handoff is accepted by the next session that starts in its project, so
 * the hook has to decide whether "this directory" is "that project". The folder name is the
 * usual answer (resolveProjectName()), but a checkout is often named differently from the
 * repository it came from — `line-summarizer-bot` cloned as `bot`, or a worktree named after
 * its branch — and a handoff written from the other checkout carries the other name. The git
 * remote's repository name is the second alias, read straight from `.git/config` so the hook
 * never has to spawn git.
 *
 * Reading the disk is why this is not inside render-session-context.js, which stays pure.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * The repository name of the `origin` remote, or null. Handles a plain `.git` directory and
 * the `gitdir: …` file a worktree carries (its config lives two levels up from the worktree
 * entry). Any failure is a null: an alias is a convenience, never a reason to stop the hook.
 *
 * @param {string|null|undefined} projectDir
 * @param {typeof fs} [fsModule]
 * @returns {string|null}
 */
export function gitRemoteRepoName(projectDir, fsModule = fs) {
  if (!projectDir) return null;
  try {
    const dotGit = path.join(projectDir, '.git');
    let gitDir = dotGit;
    const stat = fsModule.statSync(dotGit);
    if (stat.isFile()) {
      const m = fsModule.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      const pointed = path.resolve(projectDir, m[1].trim());
      // <main>/.git/worktrees/<name> keeps its config at <main>/.git/config.
      const wt = pointed.match(/^(.*[\\/]\.git)[\\/]worktrees[\\/][^\\/]+$/);
      gitDir = wt ? wt[1] : pointed;
    }
    const config = fsModule.readFileSync(path.join(gitDir, 'config'), 'utf8');
    const section = config.match(/\[remote "origin"\]([^[]*)/);
    if (!section) return null;
    const url = section[1].match(/^\s*url\s*=\s*(.+?)\s*$/m);
    if (!url) return null;
    const last = url[1].replace(/[\\/]+$/, '').split(/[\\/:]/).pop() || '';
    const name = last.replace(/\.git$/i, '').trim();
    return name || null;
  } catch {
    return null;
  }
}

/**
 * The folder name first, the remote repository name second; duplicates and blanks dropped.
 *
 * @param {object} opts
 * @param {string|null} [opts.project]     resolveProjectName()'s answer
 * @param {string|null} [opts.projectDir]  where to look for .git
 * @param {typeof fs} [opts.fsModule]
 * @returns {string[]}
 */
export function projectAliases({ project, projectDir, fsModule = fs } = {}) {
  const out = [];
  for (const name of [project, gitRemoteRepoName(projectDir, fsModule)]) {
    const clean = String(name || '').trim();
    if (clean && !out.some((n) => n.toLowerCase() === clean.toLowerCase())) out.push(clean);
  }
  return out;
}
