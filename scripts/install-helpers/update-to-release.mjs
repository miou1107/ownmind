#!/usr/bin/env node
// update-to-release.mjs: move the OwnMind checkout to the newest release tag on main.
//
// The shell side of shared/auto-update.js's choice (v1.30.48): the session-start hook, both
// interactive upgraders and the command the AI runs on an upgrade notice used `git pull`,
// which takes whatever is at the tip of main. They call this instead, so every path updates
// to the same thing: the newest vX.Y.Z tag that is part of main's history. A machine already
// ahead of it (it updated from main before this release) is left where it is.
//
// Usage:  node update-to-release.mjs [--dir <checkout>] [--print [--no-fetch]]
//   --print     only report the release, change nothing
//   --no-fetch  with --print: use the tags already here (offline check-sync)
// Output: one line on stdout
//   UPDATED vX.Y.Z    the checkout moved to that release
//   CURRENT vX.Y.Z    it already has that release (or is ahead of it)
//   NO_RELEASE        no release tag on main; nothing was changed
//   vX.Y.Z            with --print
// Exit:   0 on any of those; 1 when fetching or moving failed (the reason on stderr).
//
// Uncommitted changes in the checkout are kept (--autostash), as `git pull --rebase
// --autostash` did; a conflict is aborted rather than left half-applied.

import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFile = promisify(execFileCb);
const here = path.dirname(fileURLToPath(import.meta.url));
const { fetchReleases, findReleaseTarget } = await import(pathToFileURL(path.join(here, '..', '..', 'shared', 'release-target.js')).href);

const argv = process.argv.slice(2);
const at = argv.indexOf('--dir');
const cwd = at >= 0 ? argv[at + 1] : process.cwd();
const printOnly = argv.includes('--print');
const noFetch = printOnly && argv.includes('--no-fetch');
const git = (args, timeout = 60_000) => execFile('git', args, { cwd, timeout, windowsHide: true });

async function midRebase() {
  return ['rebase-merge', 'rebase-apply'].some((d) => fs.existsSync(path.join(cwd, '.git', d)));
}

async function main() {
  if (!noFetch) await fetchReleases({ execFile, cwd });
  const target = await findReleaseTarget({ execFile, cwd });
  if (!target) return 'NO_RELEASE';
  if (printOnly) return target;

  const ref = `refs/tags/${target}`;
  try {
    await git(['merge-base', '--is-ancestor', ref, 'HEAD'], 10_000);
    return `CURRENT ${target}`;
  } catch { /* the release has commits this checkout does not */ }

  if (await midRebase()) await git(['rebase', '--abort']).catch(() => {});
  try {
    await git(['pull', '-q', '--rebase', '--autostash', 'origin', ref]);
  } catch {
    if (await midRebase()) await git(['rebase', '--abort']).catch(() => {});
    await git(['pull', '-q', '--ff-only', 'origin', ref]);
  }
  return `UPDATED ${target}`;
}

try {
  console.log(await main());
} catch (e) {
  // git prints \n even on Windows, where os.EOL is \r\n.
  const msg = String(e?.stderr || e?.message || e).trim().split(/\r?\n/).slice(-3).join(' ');
  console.error(`update-to-release: ${msg}`);
  process.exitCode = 1;
}
