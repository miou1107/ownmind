# v1.26.103 — Spec

## Requirement: a staged rename contributes only the lines it actually changed

The pre-commit content scan MUST evaluate a renamed file against the content it gained in
this commit, not against its whole body. When a staged change is a rename or a copy, the
scan MUST supply git with both the source and the destination path so the two sides can be
paired.

A file whose bytes are unchanged MUST therefore produce no scannable content, whatever path
it now sits at.

### Scenario: moving a committed file that holds key-shaped text

- **GIVEN** a committed file containing a string matching a known credential format —
  a spec's positive example, a checksum table, a test fixture
- **WHEN** it is moved with `git mv` and staged, with no edit
- **THEN** the commit is not blocked

### Scenario: moving a file and adding a secret in the same commit

- **GIVEN** the same committed file
- **WHEN** it is moved and a line containing a credential is appended
- **THEN** the commit is blocked, and the reported match is the appended credential

### Scenario: moving a file and rewriting its contents

- **WHEN** a file is moved and its existing lines are replaced with a credential
- **THEN** the commit is blocked — an edited blob is new content whatever its path

## Requirement: a path git hands back is read as a path, not as a pattern

The source path supplied to the content scan MUST be passed with `--literal-pathspecs`.

Git returns these paths and then reads them back as pathspecs, and `--` does not disable
that. `:!victim.txt` is a legal filename and also an exclude pattern: pairing it with its
destination cancels the destination out of its own diff, git returns nothing, and a secret
added in that same commit is never scanned. This is the only direction in which the change
could scan less than the code it replaces, so it is specified rather than left to review.

### Scenario: a committed file whose name begins with pathspec magic

- **GIVEN** a file committed as `:!victim.txt`
- **WHEN** it is renamed to an ordinary name and a credential is appended in the same commit
- **THEN** the commit is blocked, and the reported match is the appended credential

### Scenario: the same filename moved with no edit

- **WHEN** a file committed as `:colon-start.txt` is moved with no content change
- **THEN** the commit is not blocked — an unusual filename must not decide either verdict

## Requirement: rename detection is not left to the user's configuration

The two invocations that decide what gets scanned — the raw lookup that finds rename
sources, and the per-file content diff — MUST pass `-M` explicitly rather than relying on
`diff.renames`. (`getStagedFiles()`, which only assembles the list of paths, does not need
it: with rename detection off the destination still arrives as an `A` and the source is
dropped as a `D`, which is the same list.)

With rename detection off, git reports a move as an unrelated delete plus add. The source
path is then absent from the raw diff, the scan cannot pair the paths, and it reverts to
reading the entire file as newly added — a false block whose cause is a setting the user
had every right to change and no reason to connect to this.

### Scenario: a repository configured with diff.renames=false

- **GIVEN** `diff.renames` is `false` in the repository's config
- **WHEN** a committed file holding key-shaped text is moved with `git mv`
- **THEN** the commit is not blocked, exactly as with the default configuration

## Requirement: the scan fails towards scanning

If the rename lookup cannot be completed, it MUST yield no rename information rather than
propagate an error, so every staged file is scanned as a whole.

Failing the other way would turn any error in this lookup into silent, repository-wide
skipping of the secret scan.

### Scenario: the rename lookup fails

- **WHEN** `git diff --cached --raw` cannot be run or its output cannot be parsed
- **THEN** no path is treated as renamed, and each staged file is scanned in full

## Known limits

**`diff.renameLimit` still bites the edited-during-a-move case.** Exact renames — identical
blobs — are found by a cheap pre-pass that the limit does not govern, verified by moving 60
identical files with `diff.renameLimit=1` and getting 60 × `R100`. Inexact renames are not:
in a large enough batch, a file that was moved *and* edited degrades to a delete plus an add,
its source path is lost, and it is scanned whole — the original false block, surviving in a
narrow case. This is a git limitation, and the blob-SHA approach would not have helped either,
since that file's blob genuinely changed.

**A destination path that is a directory prefix of other staged files over-reports.** Pathspec
`p` also matches `p/*`, so renaming a file `p` to `q` while creating a directory `p/` pulls
`p/leak.txt`'s added lines into `q`'s diff. It errs towards scanning, and `p/leak.txt` is
scanned on its own account regardless; the only consequence is that the block message can name
the wrong file.
