# A directory nobody removes

## Why

v1.26.153 fixed one test file that left its fixture directories behind, and wrote a guard that
watches that one file. Its own tasks note said the obvious thing plainly:

> **Auditing the rest of `tests/` for the same defect.** Worth doing and out of scope here.

The audit, run 2026-08-13 against the system temp folder on the machine that runs this suite:

```
ownmind-keyfile-        1679
ownmind-hookfix-         803
ownmind-creds-           730
ownmind-sc-              483
ownmind-cache-           438
ownmind-postcommit-repo- 400
ownmind-postcommit-home- 400
ownmind-sh-              182
ownmind-hook-             74
ownmind-cmd-              64
```

**5264 directories, eleven prefixes, oldest six days old.** v1.26.153 fixed one of at least
eleven leaking files, and the ten it did not fix were invisible because an empty directory
breaks nothing. No test went red. No log said anything. The only symptom was a temp folder
that grows until somebody counts it.

This is the fifth defect of the same shape found in a week: a fix exists, it covers some of the
cases, and nothing says which ones it does not cover.

## What changes

**One way to get scratch space.** `tests/helpers/temp-dir.js` exports `tempDir(prefix)`, which
draws the directory and removes it when the file that asked for it finishes. Cleanup lives in
one place instead of being a habit 80 files are each trusted to remember.

**106 call sites in 80 files converted.** Mechanical: `fs.mkdtempSync(path.join(os.tmpdir(),
'x-'))` becomes `tempDir('x-')`. Files that already cleaned up keep their own cleanup and lose
nothing — removing a directory twice is a no-op.

**A guard that makes opting out loud.** `tests/no-unregistered-temp-dir.test.js` fails when any
file under `tests/` draws a temp directory directly. It also asserts that its own pattern still
recognises the thing it forbids, and — in a child process with its temp directory pointed at an
empty one — that the helper really does remove what it handed out.

Converting 80 files fixes 80 files. The guard is what stops the eighty-first, which is exactly
how ten of these came to be written after the first one was understood.

## The 5264

Removed. That part is an afternoon's tidying and is not the deliverable; without the helper and
the guard they would be back inside a week, which is how long it took to accumulate them.

## Impact

- `tests/helpers/temp-dir.js` — new.
- `tests/no-unregistered-temp-dir.test.js` — new.
- 80 files under `tests/`, converted.
- No product code. Nothing outside `tests/`.
