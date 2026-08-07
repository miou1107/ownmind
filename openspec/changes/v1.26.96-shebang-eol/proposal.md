# v1.26.96 — Proposal: a hand-written list did not report the file it was missing

## Background

Reported by vin-windows as bug #17, on Windows 10 / Git Bash / `core.autocrlf=true`.

`.gitattributes` pinned the git hooks to LF one line at a time:

```
hooks/ownmind-git-pre-commit      text eol=lf
hooks/ownmind-git-post-commit     text eol=lf
```

`hooks/ownmind-git-commit-msg` was added after that list was written, and nobody extended
it. On a fresh Windows clone it is the one hook of the three that arrives CRLF:

```
i/lf  w/lf    attr/text eol=lf     hooks/ownmind-git-post-commit
i/lf  w/lf    attr/text eol=lf     hooks/ownmind-git-pre-commit
i/lf  w/crlf  attr/                hooks/ownmind-git-commit-msg
```

Scanning the whole repository rather than the three files in the report: **32 tracked files
carry a shebang and have no `eol=lf` rule.**

## Impact today: none, and that is the point

Measured by the reporter: Git for Windows executes both `#!/bin/sh` and `#!/usr/bin/env
bash` with CRLF endings, and `GIT_TRACE=1` confirms all three hooks are spawned and run.

So this is a wrong shape, not a live fault. It becomes a fault when the shell provider
changes — WSL's `sh`, busybox — where a CRLF shebang makes the kernel look for an
interpreter whose name ends in a carriage return.

## Second half: an existing install never repairs itself

`.gitattributes` governs what a *checkout* writes. A machine that already has these files
as CRLF stays that way permanently: git compares normalised content, so a CRLF working file
is not a difference against an LF index, `git status` is clean, and neither `pull` nor a
later attribute change rewrites it. The copies git actually executes (`~/.ownmind/git-hooks/`)
are made from those files, so they inherit it.

Fixing that needs a deliberate `git add --renormalize`, which no user will run. The
installer is the one moment it can be put right for them.

## What this changes

1. `.gitattributes` uses a glob for the hooks, and covers `*.js` / `*.cjs` / `*.mjs`, which
   is where the other 31 live.
2. `tests/shebang-eol.test.js` derives the list from `git ls-files` and fails when a
   shebang file is not covered — so the next file added cannot slip through the way
   `commit-msg` did. A written list does not report the file it is missing; this is the
   same reasoning as the v1.26.90 stdin scan and the reporter's own suggestion.
3. `install.sh` strips CR when copying the hooks into `~/.ownmind/git-hooks/`, so an
   already-CRLF machine is repaired by running the installer.

## Not done

`git add --renormalize` on the repository itself. Every tracked file was already LF in the
index when this was written — checked across all 913, and the new test asserts it for the
50 shebang files — so there is nothing to renormalise. The problem was only ever what a
Windows *checkout* produced.

## Found in review

An explicit `text` attribute **overrides** git's binary auto-detection, so `*.js text
eol=lf` swept in two tracked files containing NUL bytes. One of them,
`tests/install-check-null-byte-sanitize.test.js`, is a fixture whose entire purpose is exact
byte content: the next CR to land in it would have been rewritten on commit — a new
instance of the very class this change exists to remove.

It is exempted with `-text -eol`; `-text` alone is not enough, because setting `eol`
enables conversion and effectively sets `text`. The other file used a raw NUL as a
composite-key separator and now uses the `\0` escape, which is identical to the engine and
keeps the file out of git's binary classification. Both verified by appending a CRLF line in
a throwaway clone: the fixture kept its bytes, an ordinary `.js` lost the CR.

The repair also reaches one more path than first written. `interactive-upgrade.sh` re-runs
`install.sh` only when it finds credentials; without them it falls back to
`scripts/update.sh`, which never touched the git hooks. That path now repairs them in
place.


## Revised after bug #19: a whitelist, narrower or wider, is still a whitelist

The first cut added a glob for the hooks and three extension rules. The reporter's follow-up
made the point that the *shape* is the defect: 906 tracked files, 28 covered before, 484
after — and the next file added in a directory nobody thought of is missed again.

`.gitattributes` is now one global rule plus the exceptions:

```
* text=auto eol=lf

*.ps1 / *.bat / *.cmd / *.vbs   text eol=crlf
```

Measured in a throwaway clone before adopting it: all 906 files covered, both binary files
still detected as binary, and `git add --renormalize .` changes nothing but `.gitattributes`
itself — no content churn at all.

`text=auto` is load-bearing and was verified independently. `* eol=lf` alone sets `text`
unconditionally, which turns off binary sniffing; the reporter measured 13 bytes in, 11 out
on a file containing `0x0D 0x0A`. This repository has a live instance: `CHANGELOG.md`
carries four literal NUL bytes from an old entry about handling NUL bytes, and git classifies
it as binary today.

The test changed with it. Nothing can be missing from a `*` rule, so the test now guards the
shape: the global rule exists, `text=auto` is still on it, the exceptions come after it, git
itself agrees every tracked file is covered, and binary content is still detected.

Two of the reporter's suggestions were not taken:

- **A `scripts/check-eol.sh` for CI.** This repository has no CI — `.github/` holds only
  CODEOWNERS. The same assertions already run in `npm test`; a second implementation would
  be two places to drift.
- **Dropping the test entirely** ("nothing can be missed, so no test is needed"). What the
  test catches is not a missed file, it is somebody narrowing the rule back to a list or
  dropping `text=auto` — and the reporter's own proposal contains a script doing exactly
  that check.

`.editorconfig` was added, as suggested: `.gitattributes` governs git, not what an editor
writes on save, and the two disagreeing makes files flip back and forth.
