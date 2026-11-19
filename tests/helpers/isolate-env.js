/**
 * Removes the developer's own OwnMind settings from the environment before any test runs.
 *
 * Loaded with `node --test --import ./tests/helpers/isolate-env.js` (see `npm test`). The
 * test runner passes `--import` on to every test file's process, so this runs once per file,
 * before the file's own imports, and every `spawn(..., { env: { ...process.env } })` after it
 * inherits the cleaned environment.
 *
 * Why (issue #201): a developer whose login shell exports OWNMIND_API_KEY, OWNMIND_API_URL
 * and OWNMIND_REPLY_LINT_MODE saw 30 hook tests fail that pass in CI. About 80 test files
 * spawn hooks with `...process.env`, so the hooks found the real key, fetched the real
 * account's rules from the production server, and printed that account's banners into output
 * the tests expected to be silent. Fixing it in one place, here, covers every file at once,
 * including the next one written the same way.
 *
 * What is removed: every variable whose name starts with OWNMIND_, except the prefixes in
 * HARNESS_PREFIXES. Those are switches for the test harness itself (how long to wait for the
 * test database, where acceptance runs keep their evidence). No product code reads them —
 * `tests/test-env-isolation.test.js` checks that against the source — so a developer setting
 * one cannot change what a hook does.
 *
 * A test that needs an OwnMind variable sets it itself, after this has run: either on
 * `process.env` in the test file or in the `env` it hands to a child. Both still work.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HARNESS_PREFIXES = ['OWNMIND_TEST_', 'OWNMIND_ACCEPTANCE_'];

/**
 * @param {Record<string, string | undefined>} env — mutated in place
 * @returns {string[]} the names removed, for the test that pins this behaviour
 */
export function stripOwnMindEnv(env) {
  const removed = [];
  for (const name of Object.keys(env)) {
    // Windows environment names are case-insensitive, so `ownmind_api_key` is the same
    // variable there; compare in upper case to remove it on every platform.
    const upper = name.toUpperCase();
    if (!upper.startsWith('OWNMIND_')) continue;
    if (HARNESS_PREFIXES.some((p) => upper.startsWith(p))) continue;
    delete env[name];
    removed.push(name);
  }
  return removed;
}

/**
 * Points git at an empty global config for this test file and everything it spawns.
 *
 * The second way the developer's account leaked in (issue #201): installing OwnMind sets
 * `core.hooksPath` in ~/.gitconfig to ~/.ownmind/git-hooks. A test that makes a scratch repo
 * and runs `git commit` in it then ran the developer's real pre-commit hook, which read the
 * real key from ~/.claude.json and blocked the commit with that account's own rules. Measured
 * 2026-11-19: six tests in three files failed this way after the variables were removed.
 *
 * CI has no ~/.gitconfig at all, so an empty one is what CI sees. The file is per process and
 * writable, because some tests run installers that call `git config --global`; they write here
 * instead of into the developer's ~/.gitconfig. A test that wants its own global config still
 * sets GIT_CONFIG_GLOBAL in the child's env, which wins.
 *
 * Two consequences worth knowing when writing a test:
 *   - a `.gitconfig` placed in a fake HOME is ignored, because GIT_CONFIG_GLOBAL outranks
 *     $HOME/.gitconfig. Set GIT_CONFIG_GLOBAL in the child's env instead.
 *   - every fake HOME in one test file shares this one file. Nothing writes to it today
 *     (measured on a full macOS run), so if something starts to, the exit hook says so on
 *     stderr rather than letting one test's hooksPath leak into the next one silently.
 *
 * Cleanup runs on 'exit', which a SIGINT or SIGKILL skips, so each load also removes the
 * files left by test processes that are no longer running.
 *
 * @param {Record<string, string | undefined>} env — mutated in place
 * @returns {string} the empty config file now named by env.GIT_CONFIG_GLOBAL
 */
export function isolateGitGlobalConfig(env) {
  removeOrphanedGitConfigs();
  const file = path.join(os.tmpdir(),
    `${GITCONFIG_PREFIX}${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(file, '');
  process.on('exit', () => {
    try {
      const written = fs.readFileSync(file, 'utf8');
      if (written) {
        process.stderr.write(`[isolate-env] a test wrote to the shared empty git config ${file}; `
          + 'tests in this file now share it. Set GIT_CONFIG_GLOBAL in that test\'s child env.\n'
          + written + '\n');
      }
      fs.rmSync(file, { force: true });
    } catch { /* best effort at exit */ }
  });
  env.GIT_CONFIG_GLOBAL = file;
  return file;
}

const GITCONFIG_PREFIX = 'ownmind-test-gitconfig-';

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return err.code === 'EPERM';
  }
}

function removeOrphanedGitConfigs() {
  let names;
  try { names = fs.readdirSync(os.tmpdir()); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(GITCONFIG_PREFIX)) continue;
    const pid = Number(name.slice(GITCONFIG_PREFIX.length).split('-')[0]);
    if (!Number.isInteger(pid) || pid <= 0 || isRunning(pid)) continue;
    try { fs.rmSync(path.join(os.tmpdir(), name), { force: true }); } catch { /* another process got it */ }
  }
}

stripOwnMindEnv(process.env);
isolateGitGlobalConfig(process.env);
