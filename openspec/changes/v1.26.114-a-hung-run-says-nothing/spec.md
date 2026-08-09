# v1.26.114 — Spec

## Requirement: every script that runs the runner carries a deadline

Every `npm` script that invokes `node --test` MUST pass `--test-timeout`, and the value MUST
be at least 60000ms and at most half the tightest `timeout-minutes` declared in
`.github/workflows/test.yml`.

Without one, a test or a file that never finishes is waited on until the CI job's own
`timeout-minutes` ends it — twenty minutes of no output, reported as `cancelled`.

The bounds exist in both directions and neither is decoration:

- **Lower.** A deadline near the length of a normal run turns a slow runner into a red build,
  which is a worse failure than the one being caught: the suite takes 30s on ubuntu and 47s
  on macOS.
- **Upper.** A deadline the job's own limit beats to the punch gives back exactly the silence
  this exists to remove. It is derived from the workflow rather than written down twice, so
  raising `--test-timeout` past the job cap fails instead of quietly reinstating the bug.

The set of scripts is read from `package.json` rather than listed, so a new script that runs
the suite cannot be added without one.

### Scenario: somebody raises the deadline to silence a flake

- **GIVEN** `--test-timeout` set to 30 minutes, against a job capped at 20
- **WHEN** the guard runs
- **THEN** it fails, because at that value the job is killed before the deadline can fire and
  the run is silent again

### Scenario: a test that never settles

- **GIVEN** a test file whose test awaits a promise nothing resolves
- **WHEN** it is run under the deadline
- **THEN** the run ends non-zero, and the report contains the test's name and the reason it
  was given up on

### Scenario: the deadline is what ended it

- **GIVEN** the same file
- **WHEN** it is run *without* the deadline
- **THEN** it must still be running well after the deadline would have fired

  Without this check, the scenario above would pass on a runner that ended the probe for an
  unrelated reason, and the deadline would be credited with something it did not do.

### Scenario: neither probe shape hangs on this runtime

- **GIVEN** a node version where every probe shape ends on its own
- **WHEN** the check runs
- **THEN** it MUST fail rather than pass

  A check that observes no hang has not observed the deadline working; it has observed
  nothing. Passing there is the same false green as a "0 results" report with no control.

## Requirement: what the deadline does not cover is written down, not assumed

The behaviour of `--test-timeout` differs across the node versions CI runs, and the
difference MUST be recorded rather than generalised from whichever version happened to be
tested.

Measured on node 20.20.2 and node 24.2.0:

| shape | node 20 | node 24 |
|---|---|---|
| a test that never settles | fails on its own (`cancelledByParent`, ~2ms) | bounded and named |
| a file that passes but leaves a handle open | bounded and named | not bounded |

### Scenario: the guard is written against measured behaviour, not one version's

- **GIVEN** the two shapes above
- **WHEN** the guard runs on either version
- **THEN** it establishes which shapes hang *on that runtime* before asserting anything about
  them, so it neither hard-codes one version's behaviour nor claims coverage it does not have
