#!/usr/bin/env node
/**
 * Shell-facing predicate for dep-floor.mjs. Called by scripts/update.sh and
 * scripts/update.ps1 to decide whether a root dependency needs installing.
 *
 *   node dep-floor-cli.mjs <ownmindDir> <package> <minVersion>
 *
 *   exit 0  installed version meets the floor — skip the install
 *   exit 1  missing, older, or unreadable — run the install
 *
 * Writes nothing to stdout, so callers can use it as a plain predicate. A
 * PowerShell function returns whatever is left on the pipeline, so stray stdout
 * there would be returned alongside the boolean.
 *
 * This file exists separately from dep-floor.mjs so that it needs no "was I
 * invoked directly?" check. Any such check compares the invocation path against
 * the module's own path, and those differ whenever a path component is a
 * symlink — on a mismatch the CLI body would be skipped, the process would exit
 * 0, and the caller would read that as "floor met" and never install again.
 * Splitting the file means the body always runs, so the only exit codes are the
 * two documented above.
 *
 * Every failure exits 1. The cost is a redundant idempotent `npm install`; the
 * cost of exiting 0 by accident is a security patch that never arrives.
 */

import { satisfiesFloor, readInstalledVersion } from './dep-floor.mjs';

const [ownmindDir, pkg, floor] = process.argv.slice(2);

if (!ownmindDir || !pkg || !floor) {
  process.stderr.write('usage: dep-floor-cli.mjs <ownmindDir> <package> <minVersion>\n');
  process.exit(1);
}

try {
  process.exit(satisfiesFloor(readInstalledVersion(ownmindDir, pkg), floor) ? 0 : 1);
} catch (err) {
  process.stderr.write(`dep-floor-cli: ${err.message}\n`);
  process.exit(1);
}
