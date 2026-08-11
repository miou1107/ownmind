// v1.26.144 — the upgrader used to call its own output "your changes".
//
// `scripts/interactive-upgrade.sh` and `.ps1` decide whether the working tree is dirty
// from `git status --porcelain`. Non-empty means "the user edited the checkout": save a
// backup, file an `upgrade_dirty_tree` report, `git reset --hard origin/main`.
//
// Measured on a real installation on 2026-08-11, that check was non-empty on a machine
// nobody had touched:
//
//     M hooks/ownmind-usage-scanner.js    <- committed 100644, chmod +x by both installers
//    ?? bin/                              <- written by install.sh
//    ?? reports/                          <- written by the daily health report
//
// Neither entry is the user's, and neither survives being answered: reset restores 100644
// and the sync script at the end of the same upgrade sets 100755 again, while reset cannot
// remove an untracked file at all. So the destructive branch fired on every upgrade, on
// every macOS and Linux machine, and the warning it prints became something to scroll past
// — which is what it costs, because a real edit prints the same way.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const UPGRADE_SH = read('scripts/interactive-upgrade.sh');
const UPGRADE_PS1 = read('scripts/interactive-upgrade.ps1');

describe('files the installers make executable are committed executable', () => {
  // The list is read out of the installers rather than written here. A hand-written list
  // is what .gitignore has twice, and both times it was short by however many paths had
  // been added since somebody last looked. This one cannot go stale: the next
  // `chmod +x` someone adds is in it the moment they add it.

  /** Every checkout-relative path either installer chmods +x. */
  const chmodTargets = () => {
    const targets = new Set();
    for (const source of [read('install.sh'), read('scripts/update.sh')]) {
      for (const m of source.matchAll(/chmod \+x "([^"]+)"/g)) {
        const raw = m[1];
        // Only paths inside the checkout can have a committed mode. The copies under
        // ~/.claude/hooks and ~/.ownmind/git-hooks are not tracked anywhere.
        const rel = raw
          .replace(/^\$\{?OWNMIND_DIR\}?\//, '')
          .replace(/^"?\$\{?HOME\}?\/\.ownmind\//, '');
        if (rel === raw) continue;
        targets.add(rel);
      }
    }
    return [...targets];
  };

  const committedMode = (rel) => {
    const out = execFileSync('git', ['ls-files', '-s', '--', rel], { cwd: ROOT, encoding: 'utf8' });
    return out.trim() ? out.trim().split(/\s+/)[0] : null;
  };

  it('finds the paths by reading the installers', () => {
    const targets = chmodTargets();
    assert.ok(targets.length > 0, 'the extractor found no chmod +x targets at all');
    assert.ok(targets.includes('hooks/ownmind-usage-scanner.js'),
      `expected the scanner hook among ${JSON.stringify(targets)}`);
  });

  it('every one of them is recorded 100755', () => {
    const wrong = chmodTargets()
      .map((rel) => ({ rel, mode: committedMode(rel) }))
      .filter(({ mode }) => mode !== null && mode !== '100755');
    assert.deepEqual(wrong, [],
      'these are chmod +x by an installer but committed non-executable, so every '
      + 'installation is mode-dirty from the moment it is installed');
  });

});

describe('the dirty decision, run as the script runs it', () => {
  // The exact `git status` invocation is lifted out of the script and run against a real
  // repository in both states. Binding it to the source line is what makes this a test of
  // the upgrader rather than a test of git: drop `--untracked-files=no` and the extracted
  // command changes, and these run again against real git and fail.

  const statusArgsFromShell = () => {
    const m = UPGRADE_SH.match(/DIRTY=\$\(git status ([^\n]*?) 2>/);
    assert.ok(m, 'could not find the DIRTY assignment in interactive-upgrade.sh');
    return m[1].trim().split(/\s+/);
  };

  const seedRepo = async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ownmind-dirty-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'original\n');
    git('add', 'tracked.txt');
    git('commit', '-qm', 'seed');
    return { dir, git };
  };

  it('reads a checkout carrying only OwnMind output as clean', async () => {
    const { dir, git } = await seedRepo();
    try {
      // The two paths measured on the real installation.
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.writeFileSync(path.join(dir, 'bin', 'run-scanner.sh'), '#!/bin/sh\n');
      fs.mkdirSync(path.join(dir, 'reports'));
      fs.writeFileSync(path.join(dir, 'reports', 'health-2026-08-11.md'), '# health\n');

      const out = execFileSync('git', ['status', ...statusArgsFromShell()],
        { cwd: dir, encoding: 'utf8' });
      assert.equal(out.trim(), '',
        'untracked output chose the reset --hard branch, which cannot remove it, '
        + 'so it would choose it again on every later upgrade');
      void git;
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('still reads an edit the user made as dirty', async () => {
    const { dir } = await seedRepo();
    try {
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'the user changed this\n');
      const out = execFileSync('git', ['status', ...statusArgsFromShell()],
        { cwd: dir, encoding: 'utf8' });
      assert.match(out, /tracked\.txt/,
        'a modified tracked file must still be backed up and reported');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('still reads a mode change as dirty', async () => {
    // Not hypothetical: this is the entry that was on the real machine. Committing the
    // exec bit is what removes it — the check must keep being able to see one.
    const { dir, git } = await seedRepo();
    try {
      fs.chmodSync(path.join(dir, 'tracked.txt'), 0o755);
      const out = execFileSync('git', ['status', ...statusArgsFromShell()],
        { cwd: dir, encoding: 'utf8' });
      assert.match(out, /tracked\.txt/, 'a mode change is a tracked change');
      void git;
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('both upgraders decide the same way', () => {
  // IR-022. The two scripts have diverged before, and a Windows-only destructive branch is
  // the kind of thing nobody notices from a Mac.

  it('the shell upgrader excludes untracked files from the decision', () => {
    const m = UPGRADE_SH.match(/DIRTY=\$\(git status ([^\n]*?) 2>/);
    assert.ok(m, 'no DIRTY assignment found');
    assert.match(m[1], /--untracked-files=no/);
  });

  it('the powershell upgrader excludes them too', () => {
    const m = UPGRADE_PS1.match(/\$dirty = git status ([^\n]*?) 2>/);
    assert.ok(m, 'no $dirty assignment found');
    assert.match(m[1], /--untracked-files=no/);
  });

  it('both still log what is untracked rather than hiding it', () => {
    assert.match(UPGRADE_SH, /untracked paths present/);
    assert.match(UPGRADE_PS1, /untracked paths present/);
  });

  it('neither logs it by way of the reset branch', () => {
    // The untracked listing must sit before the `if dirty` branch, not inside it —
    // inside, it would only ever print on the runs that were already destructive.
    const shList = UPGRADE_SH.indexOf('untracked paths present');
    const shBranch = UPGRADE_SH.indexOf('if [ -n "${DIRTY}" ]');
    assert.ok(shList > 0 && shBranch > 0 && shList < shBranch,
      'the shell listing must come before the dirty branch');
    const psList = UPGRADE_PS1.indexOf('untracked paths present');
    const psBranch = UPGRADE_PS1.indexOf('if ($dirty) {');
    assert.ok(psList > 0 && psBranch > 0 && psList < psBranch,
      'the powershell listing must come before the dirty branch');
  });
});

describe('the checkout ignores what OwnMind writes into it', () => {
  const IGNORE = read('.gitignore');

  // Only what OwnMind writes. A member's machine also carries an untracked `standards/`,
  // and nothing in this repository creates it — so it is theirs, and hiding someone's own
  // directory from their own `git status` is not this file's business. The change above is
  // what stops it triggering a reset.
  for (const dir of ['bin/', 'reports/']) {
    it(`ignores ${dir}`, () => {
      assert.ok(IGNORE.split('\n').some((line) => line.trim() === dir),
        `${dir} is written into the checkout by OwnMind and must not appear in git status`);
    });
  }
});
