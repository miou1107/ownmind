import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir } from './helpers/temp-dir.js';
import {
  resolveRepo,
  findGuardViolation,
  findContentMention,
  formatGuardBlock,
} from '../hooks/lib/path-guard.js';

/**
 * The one hard guarantee in this feature: an edit to a path somebody else owns does not
 * happen.
 *
 * The guard entries here are the FLAT shape the bundle ships. They are not database rows,
 * and a function written against `metadata.enforcement.guard` would match nothing on a real
 * machine while passing every test that handed it a row - so these fixtures deliberately
 * look like what `buildBundle` emits and nothing else.
 */

const GUARD = {
  id: 412,
  type: 'team_standard',
  title: 'ci ownership belongs to the colleague',
  repo_match: 'guarded-monorepo',
  paths: ['ci/**', '.gitlab-ci.yml'],
  owner: 'Colleague',
};

/** A real git repo, because the guard shells out to real git to find the repo root. */
function makeRepo(prefix, remote) {
  const dir = tempDir(prefix);
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
  return dir;
}

function touch(repo, relPath) {
  const full = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x\n');
  return full;
}

/**
 * Two paths naming the same directory on disk.
 *
 * Comparing path strings is what this asserted before, and on Windows it failed for a
 * reason that had nothing to do with the guard: `os.tmpdir()` hands back the 8.3 short
 * form (`C:\Users\RUNNER~1\…`) while git answers with the long one
 * (`C:\Users\runneradmin\…`), and `fs.realpathSync` reconciles neither. Inode and device
 * are what the filesystem itself considers identity, and they do not care how the path
 * was spelled.
 */
function sameDir(a, b) {
  const x = fs.statSync(a);
  const y = fs.statSync(b);
  return x.ino === y.ino && x.dev === y.dev;
}

test('the repo is resolved from the edited file, not the working directory', () => {
  const repo = makeRepo('om-guard-guarded-monorepo-', 'https://example.com/guarded-monorepo.git');
  const file = touch(repo, 'ci/projects.yml');
  const resolved = resolveRepo(file);
  assert.ok(resolved);
  assert.match(resolved.remote, /guarded-monorepo/);
  assert.ok(sameDir(resolved.root, repo), `${resolved.root} is not the same directory as ${repo}`);
});

test('a file whose directory does not exist yet is still caught', () => {
  // The ordinary way to add a file under a guarded path: the folder is created by the same
  // write. Before v1.30.8 the guard asked git about a directory that was not there yet, got
  // nothing, concluded the file was in no repository at all, and allowed the write — so the
  // one hard guarantee had a hole in it that any first file in a new folder walked through.
  const repo = makeRepo('om-guard-guarded-monorepo-', 'https://example.com/guarded-monorepo.git');
  const file = path.join(repo, 'ci', 'templates', 'brand-new.yml');
  assert.equal(fs.existsSync(path.dirname(file)), false, 'the fixture must not create it');

  const violation = findGuardViolation(file, [GUARD]);
  assert.ok(violation, 'a new file in a new folder under ci/ must still be blocked');
  assert.equal(violation.relPath, 'ci/templates/brand-new.yml');
});

test('a file several missing folders deep is still caught', () => {
  const repo = makeRepo('om-guard-guarded-monorepo-', 'https://example.com/guarded-monorepo.git');
  const file = path.join(repo, 'ci', 'a', 'b', 'c', 'deep.yml');
  const violation = findGuardViolation(file, [GUARD]);
  assert.ok(violation);
  assert.equal(violation.relPath, 'ci/a/b/c/deep.yml');
});

test('a new file in an unguarded folder is still allowed', () => {
  // The other half of the fix: reaching further up for the repo must not make the guard
  // start blocking paths nobody claimed.
  const repo = makeRepo('om-guard-guarded-monorepo-', 'https://example.com/guarded-monorepo.git');
  assert.equal(findGuardViolation(path.join(repo, 'src', 'new', 'index.js'), [GUARD]), null);
});

test('a differently-spelled path to the same file is still caught', (t) => {
  // The Windows failure in the shape this machine can reproduce. On a case-insensitive
  // volume `…/CaseRepo/ci/x.yml` and `…/caserepo/ci/x.yml` open the same file, and no
  // amount of realpath makes the two strings agree — so a guard that decided by comparing
  // them read the file as outside its own repository and allowed the edit.
  const repo = makeRepo('om-guard-guarded-monorepo-Case', 'https://example.com/guarded-monorepo.git');
  const file = touch(repo, 'ci/projects.yml');
  const base = path.basename(repo);
  const respelled = path.join(path.dirname(repo), base.toLowerCase(), 'ci', 'projects.yml');
  if (respelled === file || !fs.existsSync(respelled)) {
    t.skip('this filesystem is case-sensitive, so there is no second spelling to try');
    return;
  }
  assert.ok(findGuardViolation(respelled, [GUARD]), 'spelling must not decide whether a rule applies');
});

test('a forbidden path is caught even when the session is in a different repo', () => {
  // The 2026-08-13 topology exactly: the session was in one checkout, the file being edited
  // was in another. A guard that asked the working directory which repo it was in would wave
  // that edit straight through.
  const guarded = makeRepo('om-guard-guarded-monorepo-', 'https://example.com/guarded-monorepo.git');
  const elsewhere = makeRepo('om-guard-other-', 'https://example.com/some-other-project.git');
  const file = touch(guarded, 'ci/projects.yml');

  const previous = process.cwd();
  process.chdir(elsewhere);
  try {
    const violation = findGuardViolation(file, [GUARD]);
    assert.ok(violation, 'the edit must be blocked regardless of where the session started');
    assert.equal(violation.standard.id, 412);
    assert.equal(violation.relPath, 'ci/projects.yml');
  } finally {
    process.chdir(previous);
  }
});

test('the same relative path in an unguarded repo is not caught', () => {
  const other = makeRepo('om-guard-other-', 'https://example.com/some-other-project.git');
  const file = touch(other, 'ci/projects.yml');
  assert.equal(findGuardViolation(file, [GUARD]), null);
});

test('an allowed path inside the guarded repo is not caught', () => {
  const repo = makeRepo('om-guard-guarded-monorepo-', 'https://example.com/guarded-monorepo.git');
  const file = touch(repo, 'Projects/mine/src/index.js');
  assert.equal(findGuardViolation(file, [GUARD]), null);
});

test('a root-level pattern matches exactly, not as a prefix', () => {
  const repo = makeRepo('om-guard-guarded-monorepo-', 'https://example.com/guarded-monorepo.git');
  assert.ok(findGuardViolation(touch(repo, '.gitlab-ci.yml'), [GUARD]));
  assert.equal(findGuardViolation(touch(repo, 'docs/.gitlab-ci.yml.md'), [GUARD]), null);
});

test('`ci/**` matches nested paths, and does not match a lookalike sibling', () => {
  const repo = makeRepo('om-guard-guarded-monorepo-', 'https://example.com/guarded-monorepo.git');
  assert.ok(findGuardViolation(touch(repo, 'ci/templates/deep/file.yml'), [GUARD]));
  assert.equal(findGuardViolation(touch(repo, 'circle/config.yml'), [GUARD]), null);
});

test('a linked worktree is still the repository it belongs to', () => {
  // Asking git for the prefix means git decides which repository is answering, and a linked
  // worktree is where that gets interesting: its `.git` is a file pointing elsewhere, not a
  // directory. Both halves of the fix meet here - the prefix lookup and the climb past
  // folders that do not exist yet.
  const main = makeRepo('om-guard-guarded-monorepo-', 'https://example.com/guarded-monorepo.git');
  execFileSync('git', ['-C', main, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', main, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(main, 'seed.txt'), 'x\n');
  execFileSync('git', ['-C', main, 'add', '.']);
  execFileSync('git', ['-C', main, 'commit', '-qm', 'seed']);

  const linked = path.join(tempDir('om-guard-worktree-'), 'wt');
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'side', linked]);
  assert.equal(fs.statSync(path.join(linked, '.git')).isFile(), true, 'the fixture is not a linked worktree');

  assert.equal(findGuardViolation(touch(linked, 'ci/x.yml'), [GUARD])?.relPath, 'ci/x.yml');
  assert.equal(
    findGuardViolation(path.join(linked, 'ci', 'brand-new', 'y.yml'), [GUARD])?.relPath,
    'ci/brand-new/y.yml',
  );
});

test('an independent repo nested inside a guarded one answers for itself', () => {
  // The other side of letting git decide. A checkout vendored inside the guarded repo has its
  // own origin, so its `ci/` is not the guarded `ci/` however the path reads - and climbing to
  // the nearest existing ancestor must not walk out of it and answer about the parent.
  const outer = makeRepo('om-guard-guarded-monorepo-', 'https://example.com/guarded-monorepo.git');
  const inner = path.join(outer, 'ci', 'vendored');
  fs.mkdirSync(inner, { recursive: true });
  execFileSync('git', ['init', '-q', inner]);
  execFileSync('git', ['-C', inner, 'remote', 'add', 'origin', 'https://example.com/some-other-project.git']);

  assert.equal(findGuardViolation(path.join(inner, 'thing.yml'), [GUARD]), null);
  assert.equal(findGuardViolation(path.join(inner, 'new-folder', 'thing.yml'), [GUARD]), null);
  // The guarded repo's own ci/ is untouched by the neighbour.
  assert.ok(findGuardViolation(touch(outer, 'ci/projects.yml'), [GUARD]));
});

test('a file outside any repo is not caught and does not throw', () => {
  const loose = path.join(tempDir('om-guard-loose-'), 'scratch.txt');
  fs.writeFileSync(loose, 'x');
  assert.equal(findGuardViolation(loose, [GUARD]), null);
});

test('an empty guard list blocks nothing', () => {
  const repo = makeRepo('om-guard-guarded-monorepo-', 'https://example.com/guarded-monorepo.git');
  const file = touch(repo, 'ci/projects.yml');
  assert.equal(findGuardViolation(file, []), null);
  assert.equal(findGuardViolation(file, null), null);
});

test('running twice gives the same answer', () => {
  // A guard is consulted on every edit; an answer that holds only the first time is not a
  // guarantee.
  const repo = makeRepo('om-guard-guarded-monorepo-', 'https://example.com/guarded-monorepo.git');
  const file = touch(repo, 'ci/projects.yml');
  const first = findGuardViolation(file, [GUARD]);
  const second = findGuardViolation(file, [GUARD]);
  assert.equal(first.standard.id, second.standard.id);
  assert.equal(first.relPath, second.relPath);
});

test('a repo with no origin remote is left alone rather than guessed at', () => {
  const dir = tempDir('om-guard-noremote-');
  execFileSync('git', ['init', '-q', dir]);
  const file = touch(dir, 'ci/projects.yml');
  assert.equal(findGuardViolation(file, [GUARD]), null);
});

test('a document that proposes the forbidden edit is caught by its content', () => {
  // What the incident actually produced: a plan file at a perfectly legal path whose text
  // proposed the change. Matching the path alone waves it through.
  const hit = findContentMention('Stage 0: I will add an entry to ci/projects.yml', [GUARD]);
  assert.ok(hit);
  assert.equal(hit.standard.id, 412);
});

test('ordinary prose is not flagged as a content mention', () => {
  assert.equal(findContentMention('some notes about the deployment schedule', [GUARD]), null);
  assert.equal(findContentMention('', [GUARD]), null);
  assert.equal(findContentMention(null, [GUARD]), null);
});

test('the block message names the standard, the owner and what to do instead', () => {
  const repo = makeRepo('om-guard-guarded-monorepo-', 'https://example.com/guarded-monorepo.git');
  const violation = findGuardViolation(touch(repo, 'ci/projects.yml'), [GUARD]);
  const message = formatGuardBlock(violation);
  assert.match(message, /412/);
  assert.match(message, /Colleague/);
  assert.match(message, /issue/i);
  assert.match(message, /ci\/projects\.yml/);
  // The claim that made the incident: a permissions list inside the repo outranking the rule.
  assert.match(message, /admin/i);
});

test('a team standard block says the user\'s say-so does not waive it', () => {
  // Must match what the injection told the assistant up front. Two different stories about
  // who can waive a rule is worse than one strict story.
  const repo = makeRepo('om-guard-guarded-monorepo-', 'https://example.com/guarded-monorepo.git');
  const violation = findGuardViolation(touch(repo, 'ci/projects.yml'), [GUARD]);
  const message = formatGuardBlock(violation);
  assert.match(message, /team standard/);
  assert.match(message, /確認/);
});

test('a personal rule block does not demand a confirmation', () => {
  const personal = { ...GUARD, type: 'iron_rule', id: 900 };
  const repo = makeRepo('om-guard-guarded-monorepo-', 'https://example.com/guarded-monorepo.git');
  const violation = findGuardViolation(touch(repo, 'ci/projects.yml'), [personal]);
  const message = formatGuardBlock(violation);
  assert.ok(!message.includes('確認'), 'the user does not confirm to waive their own rule');
  assert.match(message, /open an issue/);
});
