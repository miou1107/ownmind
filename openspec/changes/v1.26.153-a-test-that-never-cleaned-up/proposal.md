# A test that never cleaned up after itself

## Why

`tests/sync-rules-block.test.js` creates a throwaway directory per test and removed none of
them.

Measured 2026-08-12 on the machine that runs this suite most often: one run of the file leaves
**23 directories** behind, and `C:\Users\Vin\AppData\Local\Temp` held **391** of them, the
oldest dated 2026-08-11 — roughly one day of test runs.

Nothing broke, and that is the whole reason it lasted. An empty directory fails no assertion,
slows nothing measurably, and appears in no log. The only symptom is a temp folder that grows
until somebody happens to look inside it, which is what happened during a wrap-up check
rather than through any test going red.

Every other test file in this repo already does this correctly — `fs.mkdtempSync(...)` paired
with `fs.rmSync(dir, { recursive: true, force: true })` in a `finally`. See
`tests/update-lock-mutual-exclusion.test.js`, which does it in fifteen places. This file was
the exception, and there was nothing to notice it.

## What changes

**The fixtures are tracked and removed in a file-level `after` hook.** `fixture()` pushes each
directory it creates onto a module-level list, and one `after` empties the list.

The obvious alternative — `t.after()` per test — was not taken. Reaching `t` means giving all
23 `it()` callbacks a parameter they otherwise have no use for, and a mechanical edit across
every test in a file is its own way to introduce a mistake. `after` runs whether the tests
passed or failed, which is the property that matters: **a failing assertion is exactly when
the old code leaked**, because it left the test body by the fast path.

**A cleanup that fails says so.** `rmSync` is wrapped so one locked file on Windows cannot
turn a green suite red, but the failure is written to stderr rather than swallowed. A silent
catch here would restore the original defect exactly — directories accumulating with a test
named "leaves nothing behind" passing above them.

## The guard, and why it lives in its own file

`tests/sync-rules-block-no-temp-leak.test.js` runs the subject file as a child process with
`TMPDIR` / `TEMP` / `TMP` pointed at an empty directory of its own, and asserts that directory
is empty afterwards. `os.tmpdir()` reads those variables, so every `mkdtempSync` the child
makes lands there and whatever survives is precisely what was leaked. **Nothing in the file
under test had to change to become measurable.**

It cannot live in the file it measures: a test cannot observe its own cleanup hook, which runs
after every test in its file has finished.

**It carries a positive control.** A child that never ran — wrong path, syntax error, a filter
matching nothing — leaves the scratch directory empty too, and the leak assertion would pass
while measuring nothing. So the guard first establishes that the run happened and that it was
the whole file (at least 20 tests passed) before believing what the directory says.

That control earned itself immediately. The first version of the guard failed with "could not
tell whether the child ran": Node's test runner sets `NODE_TEST_CONTEXT=child-v8` in every test
process, a `node --test` spawned from inside a test inherits it, and the child switches from
the human-readable reporter to the serialized child protocol — no `pass N` line anywhere in
stdout. Both `NODE_TEST_CONTEXT` and `NODE_TEST_WORKER_ID` are now stripped from the child's
environment.

## Verification

Both directions, on the machine where the leak was found:

| | unfixed (`HEAD` in a worktree) | fixed |
|---|---|---|
| guard | ✖ `23 temp entries survived the run: ownmind-block-0G9KbR, …` | ✔ |

The unfixed side was run by checking out `HEAD` into a separate worktree and copying only the
new guard into it, so the subject was the original file rather than a reconstruction of it.

The 391 accumulated directories were deleted after the counts and the oldest date were
recorded (IR-003).

## Impact

- `tests/sync-rules-block.test.js` — a tracked list, an `after` hook, one added line in
  `fixture()`. No test body changes, no assertion changes.
- `tests/sync-rules-block-no-temp-leak.test.js` — new.
- Nothing outside `tests/`. `scripts/install-helpers/sync-rules-block.cjs` is untouched; this
  release changes no shipped behaviour.
