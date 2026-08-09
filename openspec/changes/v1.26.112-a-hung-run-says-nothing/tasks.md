# v1.26.112 — Tasks

- [x] Establish where the hung macOS run stopped. `node --test` reports files in dispatch
      order (262 file transitions in the ubuntu log, 2 of them out of order, both explained by
      two files sharing a suite name), so the stall point is the first unreported file rather
      than an arbitrary one.
- [x] Try to reproduce: 5 full-suite runs at reduced file concurrency, and 120 runs of the
      file the stall points at with every core saturated. No hang. Re-running the CI job on
      the same commit passed in 74s. Recorded as not reproduced rather than guessed at.
- [x] `package.json` — `node --test --test-timeout=300000`. Five minutes against a suite that
      takes 30s (ubuntu) / 47s (macOS).
- [x] Confirm `--test-timeout` exists on the node the CI matrix actually installs: node
      20.20.2, not the documented minimum.
- [x] Measure what the deadline does to each shape of hang on both node versions, rather than
      assuming one behaves like the other. They differ in both directions — see spec.md.
- [x] `tests/hung-test-is-named.test.js` — drift guard on the flag and its lower bound, plus a
      positive control that builds a real hang and requires the name back. The control
      measures which shapes hang on the running node first, and fails if none do.
- [x] Reverse-verify the positive control: the same fixture without the flag must still be
      running afterwards.
- [x] Mutation-verify the drift guard: removing the flag turns it red; lowering it to 5000ms
      turns it red on the bound.
- [x] `.github/workflows/test.yml` — record next to the `npm test` step why the runner carries
      a deadline, so the next person to touch it does not remove it as noise.

## Trap found on the way

A nested `node --test` inherits `NODE_TEST_CONTEXT` from the runner that spawned it, prints
"run() is being called recursively within a test file. skipping running files", and exits 0
in 200ms without running anything. Every probe in the file passed while measuring nothing.
The helper that builds the child environment now deletes it, and says why.
