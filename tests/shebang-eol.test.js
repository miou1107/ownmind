import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * v1.26.96 — a file with a shebang must be checked out with LF endings.
 *
 * `.gitattributes` listed the git hooks one line at a time. `hooks/ownmind-git-commit-msg`
 * was added after that list was written and nobody remembered to extend it, so on a Windows
 * checkout with `core.autocrlf=true` it was the one hook of the three that arrived CRLF:
 *
 *     i/lf  w/lf    attr/text eol=lf     hooks/ownmind-git-post-commit
 *     i/lf  w/lf    attr/text eol=lf     hooks/ownmind-git-pre-commit
 *     i/lf  w/crlf  attr/                hooks/ownmind-git-commit-msg
 *
 * A CRLF shebang makes the kernel look for an interpreter whose name ends in a carriage
 * return. Git for Windows tolerates it today — measured, both `#!/bin/sh` and
 * `#!/usr/bin/env bash` still execute — so this is a wrong shape rather than a live fault.
 * It becomes a fault the moment the shell provider changes (WSL's sh, busybox).
 *
 * The list is derived here rather than written down, because a written list does not report
 * the file it is missing. That is the same reasoning as the v1.26.90 stdin scan.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/** Tracked files whose first two bytes are `#!`. */
function shebangFiles() {
  const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  return tracked.filter((f) => {
    try {
      const fd = fs.openSync(path.join(repoRoot, f), 'r');
      const buf = Buffer.alloc(2);
      fs.readSync(fd, buf, 0, 2, 0);
      fs.closeSync(fd);
      return buf.toString('latin1') === '#!';
    } catch {
      return false;
    }
  });
}

describe('v1.26.96 — every shebang file is pinned to LF', () => {
  const files = shebangFiles();

  it('finds files to check (fails closed if the listing breaks)', () => {
    // Without this, a broken `git ls-files` would make the real assertion below pass on an
    // empty set and report a clean bill of health.
    assert.ok(files.length > 20, `only found ${files.length} shebang files — is the scan working?`);
  });

  it('.gitattributes covers all of them', () => {
    const eol = execFileSync('git', ['ls-files', '--eol', '--', ...files], {
      cwd: repoRoot, encoding: 'utf8',
    }).trim().split('\n');

    const uncovered = eol.filter((line) => !/eol=lf/.test(line));
    assert.deepEqual(
      uncovered.map((l) => l.trim().replace(/\s+/g, ' ')), [],
      'these carry a shebang but no `text eol=lf` rule — add one to .gitattributes'
    );
  });

  it('none of them is stored with CRLF in the index', () => {
    // `attr/text eol=lf` governs checkout. This checks the other half: what is committed.
    const eol = execFileSync('git', ['ls-files', '--eol', '--', ...files], {
      cwd: repoRoot, encoding: 'utf8',
    }).trim().split('\n');

    const crlfInIndex = eol.filter((line) => /^i\/crlf/.test(line.trim()));
    assert.deepEqual(crlfInIndex, [], 'a shebang file was committed with CRLF endings');
  });
});

describe('v1.26.96 — the installer repairs a checkout that is already CRLF', () => {
  /**
   * `.gitattributes` only governs what a checkout writes. A machine that already has these
   * files as CRLF stays that way forever: git compares normalised content, so a CRLF
   * working file is not a difference against an LF index, `git status` is clean, and
   * nothing rewrites it — not `pull`, not a later attribute change. The hooks git actually
   * executes are copied from those files, so they inherit it.
   *
   * Running the installer is the one moment this can be put right without asking the user
   * to run `git add --renormalize`.
   */
  it('strips CR when copying the git hooks into place', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
    const start = src.indexOf('install_git_hook() {');
    assert.ok(start > 0, 'install.sh no longer defines install_git_hook');
    const end = src.indexOf('\n}\n', start);
    const fn = src.slice(start, end + 3);
    assert.match(fn, /tr -d/, 'the copy must strip CR, not plain cp');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-crlf-'));
    try {
      fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.ownmind', 'git-hooks'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'hooks', 'ownmind-git-pre-commit'),
        '#!/bin/sh\r\necho hi\r\n');

      execFileSync('bash', ['-c', [
        `OWNMIND_DIR=${JSON.stringify(dir)}`,
        `HOME=${JSON.stringify(dir)}`,
        fn,
        'install_git_hook "ownmind-git-pre-commit" "pre-commit"',
      ].join('\n')], { stdio: ['ignore', 'ignore', 'pipe'] });

      const out = path.join(dir, '.ownmind', 'git-hooks', 'pre-commit');
      const body = fs.readFileSync(out, 'utf8');
      assert.equal(body.includes('\r'), false, 'a CRLF source must land as LF');
      assert.equal(body, '#!/bin/sh\necho hi\n', 'and the content is otherwise unchanged');
      assert.ok(fs.statSync(out).mode & 0o111, 'still executable');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
