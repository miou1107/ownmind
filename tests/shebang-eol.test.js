import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

/**
 * v1.26.96 — line endings are declared once, for everything, with the exceptions listed.
 *
 * `.gitattributes` used to be a whitelist, one rule per file or extension.
 * `hooks/ownmind-git-commit-msg` was added after that list was written and nobody
 * remembered to extend it, so on a Windows checkout with `core.autocrlf=true` it was the
 * one hook of the three that arrived CRLF:
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
    // A bare floor is weak — deleting most of the list still clears it. Name the three files
    // that actually broke, so the scan has to reach them specifically; keep the count as a
    // secondary net. Without this, a broken `git ls-files` would make the assertion below
    // pass on an empty set and report a clean bill of health.
    for (const must of ['hooks/ownmind-git-pre-commit', 'hooks/ownmind-git-post-commit',
                        'hooks/ownmind-git-commit-msg']) {
      assert.ok(files.includes(must), `${must} missing from the scan — is it still tracked?`);
    }
    assert.ok(files.length > 20, `only found ${files.length} shebang files — is the scan working?`);
  });

  it('the global rule is present, and keeps text=auto', () => {
    // The whole point of the rewrite: a `*` rule cannot miss a file, so there is nothing to
    // keep in step. What has to be guarded is somebody narrowing it back to a list, or
    // dropping `text=auto`.
    //
    // `text=auto` is load-bearing. `* eol=lf` on its own sets `text` unconditionally, which
    // switches off binary sniffing — measured on a file containing 0x0D 0x0A: 13 bytes in,
    // 11 out. This repository has two binary files today, one of them CHANGELOG.md.
    const attrs = fs.readFileSync(path.join(repoRoot, '.gitattributes'), 'utf8');
    assert.match(attrs, /^\*\s+text=auto\s+eol=lf\s*$/m,
      'the global `* text=auto eol=lf` rule is gone — a per-file list will miss the next file');
  });

  it('git agrees that every tracked file is covered', () => {
    // Ask git, not the file: this is what actually decides checkout behaviour.
    const eol = execFileSync('git', ['ls-files', '--eol'], { cwd: repoRoot, encoding: 'utf8' })
      .trim().split('\n');
    const uncovered = eol.filter((line) => {
      const attr = line.split('\t')[0];
      return !/eol=(lf|crlf)/.test(attr) && !/-text/.test(attr);
    });
    assert.deepEqual(uncovered.map((l) => l.trim().replace(/\s+/g, ' ')), [],
      'these tracked files have no line-ending rule at all');
  });

  it('binary content is still detected as binary', () => {
    // If this goes to zero, `text=auto` was probably dropped: an explicit `text` overrides
    // detection, and the two files below would start being line-ending converted.
    const eol = execFileSync('git', ['ls-files', '--eol'], { cwd: repoRoot, encoding: 'utf8' })
      .trim().split('\n');
    const binary = eol.filter((l) => /^i\/-text/.test(l.trim())).map((l) => l.split('\t')[1]);
    assert.ok(binary.includes('CHANGELOG.md'),
      'CHANGELOG.md carries literal NUL bytes and must stay out of conversion');
  });

  it('Windows-native formats keep CRLF', () => {
    const out = execFileSync('git', ['check-attr', 'eol', '--', 'install.ps1', 'mcp/start.cmd'],
      { cwd: repoRoot, encoding: 'utf8' });
    assert.equal((out.match(/eol: crlf/g) || []).length, 2,
      'the exceptions must come after the global rule — last match wins');
  });

  it('every shebang file resolves to LF', () => {
    const eol = execFileSync('git', ['ls-files', '--eol', '--', ...files], {
      cwd: repoRoot, encoding: 'utf8',
    }).trim().split('\n');

    // Split on the tab: `git ls-files --eol` puts attributes before it and the path after,
    // and a path that happened to contain "eol=lf" would otherwise false-pass.
    const uncovered = eol.filter((line) => !/eol=lf/.test(line.split('\t')[0]));
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

    const crlfInIndex = eol.filter((line) => /^i\/crlf/.test(line.trim().split('\t')[0]));
    assert.deepEqual(crlfInIndex, [], 'a shebang file was committed with CRLF endings');
  });
});

describe('v1.26.96 — files with deliberate NUL bytes stay out of the text rules', () => {
  /**
   * An explicit `text` attribute overrides git's binary auto-detection: conversion then
   * happens without guessing the content type. `*.js text eol=lf` would therefore put a
   * fixture whose whole purpose is exact byte content under line-ending conversion, and the
   * next CR to land in it would be rewritten on commit — the same silent rewrite this file
   * exists to prevent.
   *
   * `-eol` as well as `-text`: setting `eol` alone enables conversion and effectively sets
   * `text`, so unsetting only `text` leaves the rule in force. Verified by appending a CRLF
   * line in a throwaway clone — the fixture kept its bytes, an ordinary .js lost the CR.
   */
  it('the NUL fixture is exempt from text conversion', () => {
    const out = execFileSync('git',
      ['check-attr', 'text', 'eol', '--', 'tests/install-check-null-byte-sanitize.test.js'],
      { cwd: repoRoot, encoding: 'utf8' });
    assert.match(out, /text: unset/, 'an explicit text attribute would override binary detection');
    assert.match(out, /eol: unset/, 'eol on its own re-enables conversion');
  });

  it('no other tracked JS file carries a raw NUL', () => {
    // The composite-key separator in observed-users.js was a literal NUL; `\0` is identical
    // and keeps the file out of git's binary classification. This stops the next one.
    const tracked = execFileSync('git', ['ls-files', '*.js', '*.cjs', '*.mjs'],
      { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    const withNul = tracked.filter((f) => {
      if (f === 'tests/install-check-null-byte-sanitize.test.js') return false;
      return fs.readFileSync(path.join(repoRoot, f)).includes(0);
    });
    assert.deepEqual(withNul, [], 'use the \\0 escape instead of a raw NUL byte');
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
    assert.match(fn, /\.tmp.*&&.*mv/s, 'write-then-move, so a dead tr cannot leave a half-written hook');

    const dir = tempDir('ownmind-crlf-');
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
      // v1.26.118 — the file is a fresh copy in a temp directory, so there is no index mode
      // to ask (see tests/helpers/executable-bit.js). On NTFS the bit cannot be observed at
      // all: chmod is a no-op there, measured as 755 reading back 666. Rather than skip the
      // platform and leave it unwatched, assert the claim it can still answer — that the
      // function asks for the bit — and keep the real observation where it is meaningful.
      if (process.platform === 'win32') {
        assert.match(fn, /chmod\s+\+x/, 'the copy must ask for the execute bit');
      } else {
        assert.ok(fs.statSync(out).mode & 0o111, 'still executable');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
