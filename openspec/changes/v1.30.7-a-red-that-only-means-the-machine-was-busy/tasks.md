# Tasks

## 1. Establish that the red was not real

- [x] Two files failed in the v1.30.6 verification run, both with ~9h durations — a timeout,
      not an assertion
- [x] Both pass when run alone
- [x] Time the slow one on its own: **55 seconds**, 30 cases, each spawning bash → hook → node

## 2. Make it fast enough that a busy minute cannot fail it

- [x] Classify every command once in a `before`, four at a time
- [x] Each test reads its recorded answer
- [x] Keep one test per command, so a real disagreement still names the command
- [x] `assert.ok(r, …)` so a missing entry fails as a setup problem rather than as a trigger
      mismatch

## 3. Give each spawn its own session

- [x] `session_id: parity-<index>` on every payload
- [x] Recorded why: the hook's hourly window is keyed on it, so `default` was shared by all
      thirty — a hidden coupling in sequence and a write race in parallel

## 4. Verify

- [x] Three consecutive runs: 17s, 16s, 15s — was 55s
- [x] 52 tests, 52 pass
- [x] Full suite

## Not touched, on purpose

`tests/reset-admin-password-script.test.js` timed out in the same run and takes under a second
alone. Fixing two things at once here would make it impossible to tell which change stopped the
false red. If it times out again, that is new information.
