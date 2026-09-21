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
  // A repository of this test's own, and an absolute path inside it.
  //
  // `ci/projects.yml` used to be passed relative, which made the fixture depend on where the
  // checkout happens to sit: the guard resolves the repo from the file's own directory, and
  // a relative path resolves against the hook process's working directory. Run from inside
  // company host's monorepo - `fontrip-agentic-process-automation/Projects/ownmind` - the same input
  // lands on `Projects/ownmind/ci/projects.yml`, which `ci/**` correctly does not match, so
  // the hook said nothing and the test read that as the guard never running. That is the
  // guard behaving exactly as designed and the fixture asking it the wrong question.
  const repo = tempDir('om-broken-guard-repo-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  // An origin, because a repository it cannot identify is one the guard deliberately leaves
  // alone. The URL is never dialled - no guard here carries `repo_match`.
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/fixture.git'], { cwd: repo });
  // `ci/` is deliberately never created. The guard has to decide about a file that does not
  // exist yet — the ordinary way a file arrives under a guarded path — which sends
  // `resolveRepo` down its missing-segment branch. Creating the directory here would quietly
  // move this test onto the other branch with nothing going red.
  const guarded = path.join(repo, 'ci', 'projects.yml');
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
      tool_input: { file_path: guarded, content: 'x' },
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

/**
 * #112 — the same net, one layer out.
 *
 * ownmind-edit-reminder.js only prints GUARD_DID_NOT_RUN when it is the process being run.
 * Since v1.30.15 it is not: every platform runs ownmind-iron-rule-check.js, which imports
 * editReminder and calls it, so a throw inside the guard lands in that file's top-level catch
 * instead — and that catch was `() => process.exit(0)`. Empty stdout, exit 0, edit allowed,
 * nobody told. Byte-identical to a healthy run on a file no rule covers.
 *
 * Staging a throw inside the guard is the point here, not a workaround for it: the reachable
 * causes are absorbed one by one upstream (#111 took two of them), and what this catch exists
 * for is the ones nobody has found. So the guard is replaced with one that throws, and the
 * question asked is what the caller is told.
 */
function stageThrowingGuard() {
  // Copy the tree with a break the hook never loads, then overwrite the guard itself. The
  // real GUARD_DID_NOT_RUN is re-exported from the untouched copy, so this asserts the
  // sentence the product ships rather than one the fixture made up.
  const { root, hook } = stageBrokenHook('ownmind-iron-rule-check.js', 'hooks/unused-by-this-test.js');
  const guard = path.join(root, 'hooks', 'ownmind-edit-reminder.js');
  fs.copyFileSync(guard, path.join(root, 'hooks', 'ownmind-edit-reminder.real.js'));
  fs.writeFileSync(guard, [
    "export { GUARD_DID_NOT_RUN } from './ownmind-edit-reminder.real.js';",
    'export async function editReminder() {',
    "  throw new Error('staged failure inside the guard');",
    '}',
    '',
  ].join('\n'));
  return { root, hook };
}

test('#112 — a guard that throws on the edit path says so instead of exiting quietly', async () => {
  const { hook } = stageThrowingGuard();
  const home = tempDir('om-112-home-');
  const target = path.join(tempDir('om-112-repo-'), 'anything.txt');

  const r = spawnSync('node', [hook], {
    input: JSON.stringify({
      session_id: 'guard-throws',
      tool_name: 'Write',
      tool_input: { file_path: target, content: 'x' },
    }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });

  // Still fail open: a broken guard must not stop somebody editing.
  assert.equal(r.status, 0, `the hook blocked the edit:\n${r.stdout}${r.stderr}`);

  const { GUARD_DID_NOT_RUN } = await import('../hooks/ownmind-edit-reminder.js');
  assert.notEqual(r.stdout.trim(), '', 'the hook exited silently, which is the bug');
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.hookSpecificOutput?.additionalContext, GUARD_DID_NOT_RUN,
    'the caller must be told the edit went unchecked, in the words the other wirings use');
});

test('#112 — a command that fails stays silent, so the notice does not ride every Bash call', () => {
  // The other half of the decision. "This edit was not checked" is a lie about `git status`,
  // and a notice printed on every command is one people learn to scroll past. This pins the
  // scoping; it does not prove the guard threw, because a command never reaches the guard.
  const { hook } = stageThrowingGuard();
  const home = tempDir('om-112-home2-');

  const r = spawnSync('node', [hook], {
    input: JSON.stringify({
      session_id: 'guard-throws-cmd',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });

  assert.equal(r.status, 0, `a command was blocked:\n${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /was not checked/,
    'the edit notice must not appear on a command');
});
