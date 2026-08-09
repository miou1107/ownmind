# v1.26.114 — Tasks

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

## From code review

- [x] `ended` treated two non-events as the deadline working: the probe budget running out
      (`ETIMEDOUT` — and the runner handles SIGTERM, so it exits 1 with no signal, which read
      as a clean failure) and the binary not being there (`ENOENT`, status null). Both
      reproduced; now `!r.signal && !r.error && r.status !== 0`. No test distinguishes this on
      its own — `named` already covers the normal path — so it is a tightening, not a fix with
      a control behind it.
- [x] The probes leaked a process per run. `child.kill()` signals the runner, which executes
      each file in a grandchild that does not receive it; the grandchild was left alive,
      reparented to init, still holding its socket. Reproduced (one survivor per run). Probes
      are spawned `detached` and the whole group is signalled, then awaited. Verified: six
      consecutive runs across both node versions leave zero.
- [x] The deadline had a lower bound and no upper one, so raising it past the job's own
      `timeout-minutes` reinstated the exact bug with the guard green. Reproduced at 30
      minutes against a 20-minute cap. The bound is now read from the workflow instead of
      written down a second time.
- [x] `spawn` had no `'error'` listener, so fork pressure (EAGAIN/EMFILE) would take down the
      whole test process rather than fail one assertion.
- [x] The second shape identified itself by basename, which any failure of that file prints.
      It now has to come back with the whole path.
- [x] `test:watch` ran the suite with no deadline and nothing checked it. The guard now grows
      over every script that invokes the runner rather than naming one.
- [x] Halved the file's wall clock (3.6s → 2.2s): shapes are probed one at a time and stop at
      the first the deadline handles, and a probe that ends resolves immediately instead of
      waiting out the evidence window.

## What Windows found afterwards (v1.26.115)

The guard itself was red on the Windows leg: `EBUSY: resource busy or locked, rmdir`. The
same class of defect this release exists to make visible, in the code that makes it visible.
Three independent causes, all fixed:

- [x] The probe's working directory was the temp directory the caller then removed. Windows
      refuses to remove a directory any process is sitting in. cwd is now the system temp
      root; the probe file was always passed as an absolute path.
- [x] `killGroup` fell through to `child.kill()` on Windows — there are no process groups and
      `process.kill(-pid)` throws there — and that path resolved without waiting for the
      process to be gone. Every path now waits for the exit event, with a 5s backstop.
- [x] The removal had no retries. Handles outlive the process briefly on Windows; now 20
      attempts, 100ms apart.
- [x] Verified on node 20 and node 24 that by the time the directory is removed the probe has
      always terminated (`exitCode` set, or `signalCode` SIGKILL) and never still running.
      Windows itself is confirmed by CI, not locally.

## Trap found on the way

A nested `node --test` inherits `NODE_TEST_CONTEXT` from the runner that spawned it, prints
"run() is being called recursively within a test file. skipping running files", and exits 0
in 200ms without running anything. Every probe in the file passed while measuring nothing.
The helper that builds the child environment now deletes it, and says why.
