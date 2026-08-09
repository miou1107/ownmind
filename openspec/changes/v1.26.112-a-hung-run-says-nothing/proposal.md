# v1.26.112 — Proposal: a run that hangs has to say what it is stuck on

## Background

On 2026-08-09, the day after CI landed, the macOS leg on `main` produced its last line of
output 20 seconds into the suite and nothing further for the next twenty minutes, until
`timeout-minutes` ended the job. GitHub records that as `cancelled`, which reads like a
person pressed a button.

A re-run of the same commit passed in 74 seconds, so there was nothing left to look at. The
same thing had happened earlier the same day on a different commit; that one was cut short by
a newer push, so it was never noticed as a hang at all.

Two runs out of six on that platform, no diagnosis available from either.

## What is wrong

`node --test` has no deadline of its own. A file that never finishes is waited on for as long
as the runner is allowed to live, and — because the runner reports files in dispatch order —
everything behind it stays unreported too. What reaches the log is silence.

This is the shape of problem the repo already has a rule about: an automated result of
"nothing" is not a result until something proves the measurement could have produced one.
A hung job proves nothing about which test hung.

## What this changes

`npm test` passes `--test-timeout=300000`.

- Every test and every file gets five minutes. The whole suite finishes in 30s on ubuntu and
  47s on macOS, so nothing legitimate is near that.
- When something exceeds it, the runner prints the test's name, or the file's path, with
  `failureType: 'testTimeoutFailure'`, and the job goes red in minutes instead of going quiet
  for twenty.

## What this does not change

It does not fix the hang. The cause is still unknown: it did not reproduce in five full-suite
runs locally, nor in 120 runs of the file the stall points at, and the one occurrence with a
full log was not reproducible on re-run. This makes the next occurrence produce a name.

It is also not a complete net. Measured on both CI node versions:

| shape of hang | node 20 | node 24 |
|---|---|---|
| a test that never settles | fails on its own in 2ms | bounded and named by the deadline |
| a file that passes but never exits | bounded and named by the deadline | still unbounded |

The gap — a leaked handle on node 24 — stays open. It is stated here rather than papered
over, because the alternative is a guard that is believed to cover more than it does.
