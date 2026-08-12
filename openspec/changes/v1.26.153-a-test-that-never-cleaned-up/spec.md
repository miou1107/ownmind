# Spec — test fixtures are removed by the file that created them

## Requirement 1 — every fixture directory is removed

`tests/sync-rules-block.test.js` MUST remove every directory `fixture()` created, whether the
tests passed or failed.

### Scenario: a normal run

- **GIVEN** a temp directory containing nothing
- **WHEN** the whole of `tests/sync-rules-block.test.js` runs against it
- **THEN** that temp directory is empty afterwards

### Scenario: a run in which an assertion fails

- **GIVEN** the same starting condition
- **WHEN** a test in the file fails
- **THEN** the fixture directories are still removed

Cleanup is registered as a hook rather than written at the end of each test body, so leaving
the test early cannot skip it. This is the case the original code got wrong in both
directions: it had no cleanup at all, and the natural fix — a trailing `rmSync` — would have
been skipped on exactly the runs that leak most.

### Scenario: cleanup itself cannot be performed

- **GIVEN** a fixture directory that cannot be removed (a locked file on Windows)
- **WHEN** the hook runs
- **THEN** the reason is written to stderr
- **AND** the test run is not failed by it

A quiet `catch` would reproduce the original defect with a passing test above it, so the
failure is reported. It does not fail the suite, because a transient lock is not a defect in
the code under test.

## Requirement 2 — the guard measures a run that actually happened

`tests/sync-rules-block-no-temp-leak.test.js` MUST establish that the child process ran the
whole subject file before drawing any conclusion from the leftover directories.

### Scenario: the child ran

- **GIVEN** the subject file spawned with its temp directory redirected to an empty one
- **WHEN** the run finishes
- **THEN** the guard reads the passing-test count out of the child's output
- **AND** requires it to be at least 20
- **AND** only then asserts the directory is empty

### Scenario: the child did not run, or ran partially

- **GIVEN** a child that failed to start, crashed, or matched no tests
- **WHEN** the guard inspects it
- **THEN** the guard fails naming that as the reason

An absent run and a clean run leave identical evidence — an empty directory. Without this the
guard would report success for a subject it never executed.

### Scenario: the child inherits the parent's test-runner environment

- **GIVEN** the guard is itself running under `node --test`
- **WHEN** it spawns `node --test <subject>`
- **THEN** `NODE_TEST_CONTEXT` and `NODE_TEST_WORKER_ID` are removed from the child's
  environment

Inherited, `NODE_TEST_CONTEXT=child-v8` switches the child to the serialized reporter and its
output carries no human-readable summary line, so the count above cannot be read.

## Requirement 3 — the guard fails against the unfixed subject

### Scenario: run against the code before this change

- **GIVEN** `tests/sync-rules-block.test.js` without the cleanup hook
- **WHEN** the guard runs
- **THEN** it fails, reporting how many entries survived and naming several of them

Verified by checking `HEAD` out into a separate worktree and copying only the guard into it:
`23 temp entries survived the run: ownmind-block-0G9KbR, …`.

## What this change does not do

It does not touch `scripts/install-helpers/sync-rules-block.cjs` or any shipped behaviour.
Every existing assertion in the subject file is unchanged.
