# Tasks

## 1. Finish the audit the previous release deferred

- [x] Read v1.26.153's own note: auditing the rest of `tests/` was named and left undone
- [x] Count what is actually in the system temp folder, by prefix, with dates
- [x] Result: 5264 directories, ten prefixes beyond the one already fixed, oldest six days old
- [x] Confirm the shape: no test failed, no log said anything — an empty directory breaks nothing

The finding is not "there is rubbish in temp". It is that ten of the eleven leaking files were
written *after* the first leak had been diagnosed and fixed, which is only possible because
nothing was watching.

## 2. Remove the 5264

- [x] Deleted 5262 (two drawn after the count started), 0 failures, 0 remaining
- [x] Restricted to `ownmind-*` and `om-*`, and to directories older than ten minutes, so a
      concurrent run could not have its scratch space pulled out from under it

Tidying, not the deliverable. They came back once already.

## 3. One way to get scratch space

- [x] `tests/helpers/temp-dir.js` — `tempDir(prefix)` draws it, a file-level hook removes it
- [x] Cleanup failure goes to stderr and does not fail the run: one file locked by a child on
      Windows should not turn a green suite red, and a silent failure would restore exactly the
      situation this module ends
- [x] `await tempDir(…)` is valid, so the async call sites converted without changing shape

## 4. Convert the call sites

- [x] 106 sites in 80 files, mechanically
- [x] Files that already cleaned up keep their own cleanup — a second removal is a no-op
- [x] Nested draws (`mkdtemp` inside a directory `tempDir` handed out) left alone: the parent
      is removed recursively

One thing worth recording, because it cost time and would cost it again. Some working-tree
copies were stale CRLF while `.gitattributes` requires LF for `.js`; git's clean filter hides
that, so `git status` was clean before the edit and every converted file came back as a
whole-file diff after it. The migration now normalises to LF, and asserts it never touches the
one `.js` marked byte-exact. Diff went from 7895/7815 to 186/106 — which is 80 imports plus
106 changed lines, and nothing else.

## 5. The guard, which is the deliverable

- [x] `tests/no-unregistered-temp-dir.test.js` fails on a hand-drawn temp directory, naming the
      file
- [x] Asserts its own pattern still matches what it forbids — otherwise a refactor turns it
      green by matching nothing
- [x] Runs a probe in a child process with `TMPDIR`/`TEMP`/`TMP` pointed at an empty directory,
      confirms the probe ran, then asserts nothing survives
- [x] Three exemptions, each named individually rather than matched by a pattern

## 6. Verify

- [x] Guard passes on its own
- [x] Full suite from the shell the suite is written for, with the temp folder counted before
      and after: 4842 tests, 4823 pass, 2 fail — both the pre-existing `bare-mount-trailing-slash`
      cases needing the gitignored `src/public/dashboard/` build
- [x] **6 directories before the run, 6 after.** The measurement, not the assertion

One run in between reported four failures, two of them in the changelog tests. Those were mine:
package.json was bumped while the suite was running, and a test that compares the changelog's
leading version to the build's version read the two files a second apart. Recorded because it
looked exactly like a regression for several minutes.

A note for whoever runs this next: running `npm test` from PowerShell resolves `bash` to WSL,
which cannot find `/bin/bash`, and roughly 180 shell-based tests fail for that reason alone.
That is an environment fact, not a result. Run the suite from Git Bash.

## What this does not do

Nothing outside `tests/`. And nothing about the other prefixes seen in the temp folder that do
not belong to this project — those are somebody else's to count.
