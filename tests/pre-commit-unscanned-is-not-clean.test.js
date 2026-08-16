/**
 * Files the scanner never read must not pass as files it found nothing in.
 *
 * Bug report #24, 2026-08-16, measured by the reporter: a 6 MB staged file carrying an AWS
 * key committed with exit 0 and no output, while the same key at 2 MB and 4 MB was blocked.
 * `getStagedAddedLines` hit execFileSync's maxBuffer, returned `[]`, and an empty list is the
 * same value a genuinely clean file produces. Binary files reach the same place by a
 * different road: their diff has no `+` lines at all.
 *
 * And a merge commit was checked by nothing whatsoever, because git runs `pre-commit` for an
 * ordinary commit and `pre-merge-commit` for a merge — never both. The person merging a
 * branch that leaks a credential is not the person who wrote the leak, which is exactly when
 * a check is worth having.
 *
 * Everything here runs the real hook against a real repository. None of these three could be
 * demonstrated any other way: each one is git deciding what to hand the scanner.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(repoRoot, 'hooks', 'ownmind-git-pre-commit.js');
// Split so this file does not itself carry a contiguous key-shaped string; the pre-commit
// scanner blocks its own fixture otherwise, correctly.
const EXAMPLE_KEY = `AKIA${'IOSFODNN7EXAMPLE'}`;

function newRepo() {
  const repo = tempDir('om-unscanned-repo-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  return repo;
}

function runHook(repo, home) {
  return spawnSync('node', [HOOK], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

test('a staged file too big to read is blocked, not waved through', () => {
  const repo = newRepo();
  const home = tempDir('om-unscanned-home-');
  // Over the 5 MB ceiling, with a real key inside it. The reporter measured 6 MB passing and
  // 4 MB blocking, so the size is the whole variable.
  const filler = 'x'.repeat(6 * 1024 * 1024);
  fs.writeFileSync(path.join(repo, 'big.txt'), `${filler}\nAWS_ACCESS_KEY_ID=${EXAMPLE_KEY}\n`);
  execFileSync('git', ['add', 'big.txt'], { cwd: repo });

  const r = runHook(repo, home);
  const said = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, `a 6 MB file with a key in it committed cleanly:\n${said}`);
  assert.match(said, /沒有被掃過/, 'blocked, but not for the right reason');
  assert.match(said, /big\.txt/, 'the user cannot act on a block that does not name the file');
});

test('an ordinary file of the same shape is still scanned and still blocked', () => {
  // The control. Without it, a hook that blocked everything would pass the test above.
  const repo = newRepo();
  const home = tempDir('om-unscanned-home2-');
  fs.writeFileSync(path.join(repo, 'small.env'), `AWS_ACCESS_KEY_ID=${EXAMPLE_KEY}\n`);
  execFileSync('git', ['add', 'small.env'], { cwd: repo });

  const r = runHook(repo, home);
  const said = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1);
  assert.match(said, /金鑰|憑證/, 'a small file must still be blocked as a leak, not as unreadable');
  assert.doesNotMatch(said, /沒有被掃過/, 'a file that WAS scanned must not be reported as unscanned');
});

test('a clean repository still commits', () => {
  // The other control: none of this may turn into blocking everything.
  const repo = newRepo();
  const home = tempDir('om-unscanned-home3-');
  fs.writeFileSync(path.join(repo, 'ok.txt'), 'nothing key-shaped here\n');
  execFileSync('git', ['add', 'ok.txt'], { cwd: repo });

  const r = runHook(repo, home);
  assert.equal(r.status, 0, `a clean commit was blocked:\n${r.stdout}${r.stderr}`);
});

test('a binary file is reported as not scanned rather than counted as clean', () => {
  const repo = newRepo();
  const home = tempDir('om-unscanned-home4-');
  // NUL bytes make git call it binary, which means its diff carries no added lines — so the
  // scanner reads nothing and, before this, said nothing.
  const buf = Buffer.concat([
    Buffer.from([0, 1, 2, 0, 255]),
    Buffer.from(`AWS_ACCESS_KEY_ID=${EXAMPLE_KEY}`),
    Buffer.from([0, 0]),
  ]);
  fs.writeFileSync(path.join(repo, 'blob.bin'), buf);
  execFileSync('git', ['add', 'blob.bin'], { cwd: repo });

  const r = runHook(repo, home);
  const said = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, `a binary file with a key in it committed cleanly:\n${said}`);
  assert.match(said, /二進位檔/);
});

test('a merge commit is checked, which is what pre-merge-commit exists for', () => {
  // The end-to-end one: a real branch, a real merge, and git choosing the hook. Everything
  // above proves the scanner; only this proves git ever calls it on a merge.
  const repo = newRepo();
  const home = tempDir('om-merge-home-');
  const hookDir = path.join(home, 'git-hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  for (const name of ['pre-commit', 'pre-merge-commit']) {
    const src = path.join(repoRoot, 'hooks', `ownmind-git-${name}`);
    const dst = path.join(hookDir, name);
    // Point the wrapper at this checkout's hooks rather than an installed ~/.ownmind.
    fs.writeFileSync(dst, fs.readFileSync(src, 'utf8').replace(
      '"$HOME/.ownmind/hooks/ownmind-git-pre-commit.js"',
      JSON.stringify(HOOK),
    ));
    fs.chmodSync(dst, 0o755);
  }
  execFileSync('git', ['config', 'core.hooksPath', hookDir], { cwd: repo });

  const env = { ...process.env, HOME: home, USERPROFILE: home };
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  execFileSync('git', ['add', 'base.txt'], { cwd: repo, env });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo, env });

  execFileSync('git', ['checkout', '-q', '-b', 'leaky'], { cwd: repo, env });
  fs.writeFileSync(path.join(repo, 'leak.env'), `AWS_ACCESS_KEY_ID=${EXAMPLE_KEY}\n`);
  execFileSync('git', ['add', 'leak.env'], { cwd: repo, env });
  // The branch author gets past with an explicit bypass — the point of this test is the
  // person merging, who did not write the leak and gets no warning at all today.
  execFileSync('git', ['commit', '-q', '-m', 'leak'], {
    cwd: repo, env: { ...env, OWNMIND_BYPASS: 'all' },
  });

  execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo, env });
  fs.writeFileSync(path.join(repo, 'other.txt'), 'other\n');
  execFileSync('git', ['add', 'other.txt'], { cwd: repo, env });
  execFileSync('git', ['commit', '-q', '-m', 'other'], { cwd: repo, env });

  // --no-ff so git really makes a merge commit, which is the case that runs the new hook.
  const merge = spawnSync('git', ['merge', '--no-ff', '-m', 'merge leaky', 'leaky'], {
    cwd: repo, encoding: 'utf8', env,
  });
  const said = `${merge.stdout}${merge.stderr}`;
  assert.notEqual(merge.status, 0, `the merge brought a credential in unchecked:\n${said}`);
  assert.match(said, /金鑰|憑證/, 'the merge was stopped, but not by the secret scan');
});
