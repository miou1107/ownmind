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

test('the repo is resolved from the edited file, not the working directory', () => {
  const repo = makeRepo('om-guard-guarded-monorepo-', 'https://example.com/guarded-monorepo.git');
  const file = touch(repo, 'ci/projects.yml');
  const resolved = resolveRepo(file);
  assert.ok(resolved);
  assert.match(resolved.remote, /guarded-monorepo/);
  assert.equal(fs.realpathSync(resolved.root), fs.realpathSync(repo));
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
