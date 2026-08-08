# v1.26.96 — Spec

## Requirement: every tracked file with a shebang is pinned to LF

A tracked file whose first two bytes are `#!` MUST be covered by a `text eol=lf` rule in
`.gitattributes`, and MUST NOT be stored with CRLF in the index.

The list of such files MUST be produced by `git ls-files` at test time, never written down.
A written list does not report the file it is missing — which is exactly how
`hooks/ownmind-git-commit-msg` came to be the only uncovered hook of three.

The scan MUST fail closed: if the listing returns implausibly few files, that is a failure
rather than a pass on an empty set.

### Scenario: a new hook is added without an attribute

- **GIVEN** a new tracked file starting with `#!` and no matching rule
- **WHEN** the suite runs
- **THEN** it fails, naming that file

### Scenario: the listing breaks

- **GIVEN** `git ls-files` returns nothing usable
- **THEN** the suite fails rather than reporting that all zero files are covered

## Requirement: running the installer repairs an already-CRLF machine

`install.sh` MUST strip CR when copying the git hooks into `~/.ownmind/git-hooks/`, rather
than copying them byte for byte. Content and the executable bit MUST be otherwise unchanged.

`.gitattributes` governs checkout only. A working tree that is already CRLF is never
rewritten by git — normalised comparison makes it invisible to `status`, `pull` and any
later attribute change — so without this, existing installs keep executing CRLF hooks
forever.

### Scenario: a CRLF source file

- **GIVEN** `hooks/ownmind-git-pre-commit` on disk with CRLF endings
- **WHEN** the installer's copy step runs
- **THEN** `~/.ownmind/git-hooks/pre-commit` contains no CR, is byte-identical apart from
  that, and is executable
