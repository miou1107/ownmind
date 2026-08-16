/**
 * A guard that could not run must not look like a guard that found nothing.
 *
 * Bug report #22, 2026-08-16. Both of these hooks caught every unexpected error and exited 0.
 * For the commit hook that printed one line above a successful commit; for the edit hook it
 * printed nothing at all, which is byte-identical to a healthy run on a file no rule covers.
 * A half-finished install, an interrupted pull, or one damaged file anywhere on the import
 * chain reaches both — and with the auto-update flow, that is a state machines get into, not
 * a hypothetical.
 *
 * Neither hook starts blocking here. The commit hook still exits 0 and the edit hook still
 * allows the write: a broken guard must not stop somebody working. What changes is that it
 * stops whispering.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A copy of a hook whose import chain is broken, the way a half-finished install breaks it.
 *
 * Staged as a real directory tree rather than mocked, because the failure being reproduced is
 * a module that will not load — which is precisely what a mock cannot stand in for.
 */
function stageBrokenHook(hookName, breakRelative) {
  const root = tempDir('om-broken-hook-');
  for (const dir of ['hooks', 'hooks/lib', 'shared', 'scripts/install-helpers']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  const copyTree = (rel) => {
    const from = path.join(repoRoot, rel);
    for (const name of fs.readdirSync(from)) {
      const src = path.join(from, name);
      if (!fs.statSync(src).isFile()) continue;
      fs.copyFileSync(src, path.join(root, rel, name));
    }
  };
  copyTree('hooks');
  copyTree('hooks/lib');
  copyTree('shared');
  copyTree('scripts/install-helpers');
  // The break: a file the hook imports, replaced with something that cannot be parsed.
  fs.writeFileSync(path.join(root, breakRelative), 'this is not valid javascript {{{');
  return { root, hook: path.join(root, 'hooks', hookName) };
}

test('the commit hook says it did not check, rather than printing an error and passing', () => {
  const { root, hook } = stageBrokenHook(
    'ownmind-git-pre-commit.js', 'scripts/install-helpers/resolve-credentials.cjs',
  );
  const home = tempDir('om-broken-home-');
  const repo = tempDir('om-broken-repo-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  // Split so this source file does not itself carry a contiguous key-shaped string — the
  // pre-commit scanner blocks its own test fixture otherwise, correctly. The file written to
  // disk still holds the whole thing, which is what the hook reads.
  const EXAMPLE_KEY = `AKIA${'IOSFODNN7EXAMPLE'}`;
  fs.writeFileSync(path.join(repo, 'leak.env'), `AWS_ACCESS_KEY_ID=${EXAMPLE_KEY}\n`);
  execFileSync('git', ['add', 'leak.env'], { cwd: repo });

  const r = spawnSync('node', [hook], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });

  const said = `${r.stdout}${r.stderr}`;
  // Still exit 0 — a broken hook must not be able to stop somebody committing.
  assert.equal(r.status, 0, `a broken hook blocked the commit:\n${said}`);
  assert.match(said, /沒有檢查|did not check/,
    `the hook did not say it failed to check. It said:\n${said}`);
  assert.doesNotMatch(said, /passed ✓/,
    'a run that checked nothing must never print the line a clean run prints');
  assert.ok(root);
});

test('an edit hook whose credentials cannot be read still runs the path guard', () => {
  // The reachable half of the bug. readCredentials() loads `resolve-credentials.cjs` lazily
  // and does NOT catch when called with no argument, so a damaged copy throws at call time.
  // It threw before the guard, landed in the catch, and exited 0 — and the guard, which needs
  // no credentials at all, never ran.
  //
  // The assertion has to be that the guard SPOKE. An earlier draft asserted only "exit 0, no
  // stack trace", which the catch already produced before the fix — the mutation check said
  // so by staying green with the fix reverted.
  const { hook } = stageBrokenHook(
    'ownmind-edit-reminder.js', 'scripts/install-helpers/resolve-credentials.cjs',
  );
  const home = tempDir('om-broken-home2-');
  fs.mkdirSync(path.join(home, '.ownmind', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ownmind', 'cache', 'enforcement.json'), JSON.stringify({
    selectors: [],
    injectables: [],
    guards: [{
      id: 412,
      type: 'team_standard',
      title: 'ci ownership',
      owner: 'Colleague',
      paths: ['ci/**'],
    }],
  }));

  const r = spawnSync('node', [hook], {
    input: JSON.stringify({
      session_id: 'broken-creds',
      tool_input: { file_path: 'ci/projects.yml', content: 'x' },
    }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });

  assert.equal(r.status, 0, `the edit hook crashed:\n${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.decision, 'block',
    'the guard did not run — credentials it does not need decided whether it got to');
  assert.match(parsed.reason, /ci ownership/);
});

test('and if it fails anyway, the assistant is told the edit went unchecked', async () => {
  // The last-resort net. Deliberately tested as the message rather than by staging a crash:
  // after the fix above, the reachable causes are absorbed, and manufacturing an unreachable
  // one would test the staging rather than the handler. What must hold is that the sentence
  // the handler emits says a check did NOT happen.
  const { GUARD_DID_NOT_RUN } = await import('../hooks/ownmind-edit-reminder.js');
  assert.match(GUARD_DID_NOT_RUN, /was not checked/);
  assert.match(GUARD_DID_NOT_RUN, /Tell the user this/,
    'the assistant must pass it on, or the user never learns the guard was off');
});
