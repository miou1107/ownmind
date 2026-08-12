# Spec — scratch space has one owner

## Requirement 1 — no test draws a temp directory by hand

### Scenario: any file under tests/

- **GIVEN** a file under `tests/`
- **WHEN** it needs a throwaway directory
- **THEN** it MUST obtain it from `tempDir()` in `tests/helpers/temp-dir.js`
- **AND** the guard MUST fail, naming the file, if it calls `mkdtemp` against `os.tmpdir()`
  directly

"Clean up after yourself" is not enforceable, because a directory that is never removed is
indistinguishable from one that is. "There is one way to get scratch space" is.

### Scenario: a directory drawn inside one already tracked

- **GIVEN** a file that calls `mkdtemp` against a directory `tempDir()` handed it
- **THEN** it is permitted

The parent is removed recursively, so the child goes with it. The rule is about the temp folder
the operating system owns, not about nesting.

### Scenario: exemptions

- **GIVEN** the helper itself, this guard, or the file-scoped leak guard from v1.26.153
- **THEN** they are exempt, and each is named individually

Named, because a regex that quietly widens is the failure this whole change is about.

## Requirement 2 — the helper removes what it hands out

### Scenario: a file finishes

- **GIVEN** a file that obtained one or more directories from `tempDir()`
- **WHEN** its last test has run
- **THEN** every directory MUST be removed

### Scenario: a directory that cannot be removed

- **GIVEN** a directory held open by a child process, as happens on Windows
- **THEN** the failure MUST be written to stderr
- **AND** MUST NOT fail the test run

A cleanup that fails silently restores exactly the situation this module exists to end. A green
suite turning red over one locked file is a worse trade.

### Scenario: a directory already removed by the file itself

- **GIVEN** a file that keeps its own cleanup
- **THEN** the second removal is a no-op and nothing is reported

## Requirement 3 — the guard proves both halves of itself

### Scenario: the pattern still recognises an offender

- **WHEN** the guard runs
- **THEN** it asserts its pattern matches a hand-drawn `mkdtemp`, and does not match a
  `tempDir()` call

Without this, a refactor that breaks the pattern turns the guard green by matching nothing —
the same silent pass being fixed here.

### Scenario: the permitted route is measured, not assumed

- **WHEN** the guard runs
- **THEN** it runs a probe file in a child process whose `TMPDIR`/`TEMP`/`TMP` point at an
  empty directory
- **AND** asserts the probe actually ran before believing what that directory says
- **AND** asserts nothing survives in it

A child that never ran leaves the directory empty too. The positive control is the difference
between measuring cleanup and measuring nothing.

## Out of scope

No product code changes. This release is entirely inside `tests/`.
