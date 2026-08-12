// Bug #13 — the version-tag reminder read OwnMind's OWN package.json version and then
// looked for a matching tag in whatever repo the user happened to be committing in.
// Inside the OwnMind repo the two coincide, so it looked correct for months. In a Go
// repo it told the user to tag OwnMind's version onto their project, on every commit.
//
// The reminder's version must come from the committed repo's root package.json;
// a repo without one gets no output at all.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(repoRoot, 'hooks/ownmind-git-post-commit.js');

// The hook only reaches the version check after the iron-rule pass, which needs a
// cached commit-triggered rule and the validator engine under $HOME/.ownmind.
function makeHome() {
  const home = tempDir('ownmind-postcommit-home-');
  const own = path.join(home, '.ownmind');
  fs.mkdirSync(path.join(own, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(own, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(own, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  fs.writeFileSync(path.join(own, 'cache', 'iron_rules.json'), JSON.stringify([
    { title: 'commit rule without conditions', metadata: { verification: { trigger: ['commit'] } } },
  ]));
  fs.copyFileSync(path.join(repoRoot, 'shared/verification.js'), path.join(own, 'shared', 'verification.js'));
  return home;
}

function makeRepo({ packageJson } = {}) {
  const repo = tempDir('ownmind-postcommit-repo-');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  if (packageJson !== undefined) {
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify(packageJson, null, 2));
  }
  fs.writeFileSync(path.join(repo, 'main.go'), 'package main\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'test commit');
  return { repo, git };
}

// The reminder is printed with console.warn → stderr; capture both streams.
function runHook(repo, home) {
  const res = spawnSync(process.execPath, [HOOK], {
    cwd: repo,
    encoding: 'utf8',
    // USERPROFILE as well as HOME: the hook calls os.homedir(), and on Windows that reads
    // USERPROFILE and ignores HOME entirely. Setting HOME alone left the hook pointed at
    // the developer's real home, where the fixture rule this test seeds does not exist —
    // so the hook printed nothing. Three of the five cases here assert that nothing is
    // printed, and passed for the wrong reason; the one positive case failed and is what
    // exposed it.
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(res.status, 0, `hook must exit 0, got ${res.status}: ${res.stderr}`);
  return res.stdout + res.stderr;
}

describe('post-commit version reminder — version comes from the committed repo, not from OwnMind', () => {
  it('says nothing in a repo without package.json (the Go-project case)', () => {
    const output = runHook(makeRepo().repo, makeHome());
    assert.doesNotMatch(output, /Version reminder/,
      'a repo with no package.json must not be told to tag anything');
  });

  it("still reminds in a Node repo, with THAT repo's version", () => {
    const { repo } = makeRepo({ packageJson: { version: '1.2.3' } });
    const output = runHook(repo, makeHome());
    assert.match(output, /Version reminder/);
    assert.match(output, /git tag v1\.2\.3/);
    // The [OwnMind v9.9.9] message prefix is fine — what must never happen is OwnMind's
    // own version being presented as this repo's version or suggested as its tag.
    assert.doesNotMatch(output, /version is 9\.9\.9/);
    assert.doesNotMatch(output, /git tag v9\.9\.9/, "OwnMind's own version must never be the suggested tag");
  });

  it('says nothing when the matching tag already exists', () => {
    const { repo, git } = makeRepo({ packageJson: { version: '1.2.3' } });
    git('tag', 'v1.2.3');
    const output = runHook(repo, makeHome());
    assert.doesNotMatch(output, /Version reminder/);
  });

  it('says nothing when package.json has no version field', () => {
    const { repo } = makeRepo({ packageJson: { name: 'app', private: true } });
    const output = runHook(repo, makeHome());
    assert.doesNotMatch(output, /Version reminder/);
  });

  it('never lets a hostile version string reach a shell', () => {
    // The version now comes from the COMMITTED repo — untrusted input. A cloned repo's
    // package.json must not be able to run commands through the tag lookup.
    const { repo } = makeRepo({ packageJson: { version: '1.2.3; touch injected' } });
    const output = runHook(repo, makeHome());
    assert.equal(fs.existsSync(path.join(repo, 'injected')), false,
      'the version field was executed by a shell');
    assert.doesNotMatch(output, /Version reminder/,
      'a string that is not a plausible version must produce no reminder at all');
  });
});
