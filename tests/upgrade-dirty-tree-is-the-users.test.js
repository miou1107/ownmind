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
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertExecutable } from './helpers/executable-bit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const UPGRADE_SH = read('scripts/interactive-upgrade.sh');
const UPGRADE_PS1 = read('scripts/interactive-upgrade.ps1');

describe('files the installers make executable are committed executable', () => {
  // The list is read out of the installers rather than written here. A hand-written list
  // is what .gitignore has twice, and both times it was short by however many paths had
  // been added since somebody last looked. This one cannot go stale: the next
  // `chmod +x` someone adds is in it the moment they add it.

  const INSTALLERS = ['install.sh', 'scripts/update.sh'];

  /**
   * Every checkout-relative path either installer chmods +x.
   *
   * Anything the extractor cannot resolve is returned as an `unparsed` entry rather than
   * dropped. A silently skipped target is the failure this whole test exists to prevent:
   * it would report a clean sweep over a list it had quietly shortened.
   */
  const chmodTargets = () => {
    const targets = new Set();
    const unparsed = [];
    for (const file of INSTALLERS) {
      const source = read(file);
      for (const line of source.split('\n')) {
        if (!/(^|\s)chmod\s/.test(line) || line.trimStart().startsWith('#')) continue;
        const quoted = line.match(/chmod \+x "([^"]+)"/);
        if (!quoted) {
          // Unquoted, numeric (chmod 755), or multi-target forms. None is used today; if
          // one appears, say so rather than passing over it.
          unparsed.push(`${file}: ${line.trim()}`);
          continue;
        }
        const rel = quoted[1]
          .replace(/^\$\{?OWNMIND_DIR\}?\//, '')
          .replace(/^\$\{?HOME\}?\/\.ownmind\//, '');
        // Still starts with a variable: it points outside the checkout (~/.claude/hooks,
        // ~/.ownmind/git-hooks, the bin dir), so it has no committed mode to check. This
        // comes before the substitution check below, because those copies are allowed to be
        // built with $(basename ...) — they are not in the repository either way.
        if (rel.startsWith('$')) continue;
        if (rel.includes('$(') || rel.includes('$')) {
          // Inside the checkout but built at runtime: the path cannot be resolved here, so
          // it cannot be checked, so it is reported rather than dropped.
          unparsed.push(`${file}: ${line.trim()}`);
          continue;
        }
        targets.add(rel);
      }
    }
    return { targets: [...targets], unparsed };
  };

  const isTracked = (rel) =>
    execFileSync('git', ['ls-files', '--', rel], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';

  it('finds the paths by reading the installers', () => {
    const { targets } = chmodTargets();
    assert.ok(targets.length > 0, 'the extractor found no chmod +x targets at all');
    assert.ok(targets.includes('hooks/ownmind-usage-scanner.js'),
      `expected the scanner hook among ${JSON.stringify(targets)}`);
  });

  it('refuses to pass over a chmod it cannot read', () => {
    const { unparsed } = chmodTargets();
    assert.deepEqual(unparsed, [],
      'these chmod lines are in a form the extractor does not resolve, so they would be '
      + 'checked by nobody. Either quote a literal path, or teach the extractor.');
  });

  it('every one of them is committed executable', () => {
    // assertExecutable is the repository's existing ruler for this (v1.26.118): it reads
    // the index mode, which is the only one a Windows leg can measure and the only one that
    // describes what everybody else gets on checkout.
    const tracked = chmodTargets().targets.filter(isTracked);
    assert.ok(tracked.length > 0, 'no chmod +x target is tracked — the extractor is wrong');
    for (const rel of tracked) assertExecutable(ROOT, rel);
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
    // -c core.hooksPath=: install.sh sets a *global* core.hooksPath, so a plain commit in a
    // throwaway repo runs OwnMind's own pre-commit and commit-msg hooks — which shell out to
    // node and can reject it. The rest of the suite guards the same way
    // (tests/pre-commit-secret.test.js).
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=', ...args],
      { cwd: dir, encoding: 'utf8' });
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
    // Not hypothetical: this is the entry that was on the real machine. Committing the exec
    // bit is what removes it — the check must keep being able to see one.
    //
    // The mode is moved in the index rather than with fs.chmodSync, because chmod is a
    // no-op on NTFS and git writes core.filemode=false there: measuring the working-copy
    // bit is a ruler that cannot read on Windows (v1.26.118). `update-index --chmod` moves
    // the recorded mode on every platform, which is the half that reaches other machines.
    const { dir, git } = await seedRepo();
    try {
      git('update-index', '--chmod=+x', 'tracked.txt');
      const out = execFileSync('git', ['status', ...statusArgsFromShell()],
        { cwd: dir, encoding: 'utf8' });
      assert.match(out, /tracked\.txt/, 'a mode change is a tracked change');
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

  it('the powershell filter matches untracked lines and not every line', () => {
    // `-like '??*'` reads as "two of any character, then anything", because `?` is a
    // single-character wildcard in -like. That would list the whole status output under a
    // heading that says untracked. -match takes a regex, where `\?\?` is two question
    // marks, and `^` keeps it to the status code column.
    const m = UPGRADE_PS1.match(/\$untracked = git status [^\n]*\n?[^\n]*Where-Object \{ ([^}]*) \}/);
    assert.ok(m, 'no untracked filter found in interactive-upgrade.ps1');
    assert.match(m[1], /-match/, 'the filter must use -match, not -like');
    assert.match(m[1], /\^\\\?\\\?/, 'the pattern must be anchored to the two-column status code');
    assert.doesNotMatch(m[1], /-like/);
  });

  it('the shell filter is anchored the same way', () => {
    assert.match(UPGRADE_SH, /grep '\^\?\?'/);
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
  // Asked of git rather than of the file's text. A later `!bin/` further down would leave a
  // string match green while git went on reporting the directory, which is the same class
  // of mistake as reading `git status` and calling the answer "the user's changes".

  const isIgnored = (rel) => {
    const r = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: ROOT });
    return r.status === 0;
  };

  // Only what OwnMind writes. A member's machine also carries an untracked `standards/`,
  // and nothing in this repository creates it — so it is theirs, and hiding someone's own
  // directory from their own `git status` is not this file's business. The change to the
  // dirty decision is what stops it triggering a reset.
  for (const dir of ['bin/run-scanner.sh', 'reports/health-2026-08-11.md']) {
    it(`git ignores ${dir}`, () => {
      assert.ok(isIgnored(dir),
        `${dir} is written into the checkout by OwnMind and must not appear in git status`);
    });
  }

  it('does not ignore a path that is not ours', () => {
    // The control. Without it, a `*` rule would pass both cases above and prove nothing.
    assert.equal(isIgnored('standards/rules.md'), false,
      'standards/ is the user\'s, and must stay visible in their own git status');
  });
});

describe('nothing stashes the user\'s work without putting it back', () => {
  // v1.26.143. `hooks/ownmind-session-start.sh` ran `git stash -q` before its pull and had
  // no `stash pop` on any path out of the block, including the successful one. v1.17.22
  // shipped the same bug in the MCP, where it made uncommitted work disappear; the fix
  // landed there and never reached here. Measured on one machine on 2026-08-11: 30 stash
  // entries, one per upgrade going back to v1.17.x.
  //
  // The list of scripts is grown by walking the repository, so a script added later is
  // covered the day it appears rather than the day somebody remembers this test.

  const scripts = () =>
    execFileSync('git', ['ls-files', '--', '*.sh', '*.ps1'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);

  it('finds scripts to check', () => {
    const found = scripts();
    assert.ok(found.length > 5, `only found ${found.length} scripts — the listing is broken`);
    assert.ok(found.includes('hooks/ownmind-session-start.sh'));
  });

  it('no script stashes without restoring in the same file', () => {
    const offenders = [];
    for (const rel of scripts()) {
      const body = read(rel);
      // `--autostash` is the flag that stashes and puts it back by itself; a bare
      // `git stash` needs a matching pop or apply somewhere in the same script.
      const bare = body.split('\n').filter((line) =>
        /git stash\b/.test(line) && !/--autostash/.test(line)
        && !line.trimStart().startsWith('#'));
      if (bare.length === 0) continue;
      if (/git stash (pop|apply)/.test(body)) continue;
      offenders.push(`${rel}: ${bare[0].trim()}`);
    }
    assert.deepEqual(offenders, [],
      'these stash the working tree and never restore it, so whatever the user had '
      + 'uncommitted stays in the stash list');
  });

  it('the session-start hook pulls with --autostash', () => {
    const body = read('hooks/ownmind-session-start.sh');
    assert.match(body, /git pull -q --rebase --autostash/);
    // The fallback must not carry --autostash: on git older than 2.6 the flag is unknown,
    // and the point of a fallback is to work where the primary path did not.
    assert.match(body, /git pull -q --ff-only/);
  });
});
