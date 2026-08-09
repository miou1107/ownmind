# v1.26.112 — Spec

## Requirement: the test run carries a deadline

`npm test` MUST invoke the runner with `--test-timeout`, and the value MUST be at least
60000ms.

Without one, a test or a file that never finishes is waited on until the CI job's own
`timeout-minutes` ends it — twenty minutes of no output, reported as `cancelled`. The lower
bound exists because a deadline near the length of a normal run turns a slow runner into a
red build, which is a worse failure than the one being caught: the suite takes 30s on ubuntu
and 47s on macOS.

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
