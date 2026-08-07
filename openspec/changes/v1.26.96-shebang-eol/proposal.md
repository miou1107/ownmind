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

`git add --renormalize` on the repository itself. Every tracked file is already LF in the
index (the test asserts it), so there is nothing to renormalise — the problem was only ever
what a Windows *checkout* produced.
