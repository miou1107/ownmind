# v1.26.107 — Spec

## Requirement: the suite runs on every supported platform, automatically

A workflow MUST run `npm test` on push to `main`, on every pull request, and on demand,
across ubuntu × node 20, ubuntu × node 24, macOS × node 20 and windows × node 20.

Before this, tests ran only where somebody ran them. A defect that only appears on another
platform is not observable from the machine the developer is on.

### Scenario: a pull request

- **GIVEN** a pull request against `main`
- **WHEN** the workflow runs
- **THEN** the three gating legs must pass for the run to be green

### Scenario: the console is not in the repository

- **GIVEN** a clean clone, where `src/public/dashboard/` is gitignored and therefore absent
- **WHEN** the workflow prepares the tree
- **THEN** it runs the same `ensure-console-build` step `npm start` runs, so the routes that
  serve the console are testable

## Requirement: Windows reports without gating, and the distinction is structural

The Windows leg MUST be a separate job carrying `continue-on-error`, not a matrix leg of the
gating job.

A `continue-on-error` matrix leg still reports `failure` in `needs.<job>.result`, so a gate
reading that value cannot distinguish "only Windows is red" from "everything is red". Users
pull updates straight from `main`, so merging is shipping, and the 109 pre-existing Windows
failures must not block a release.

### Scenario: Windows is red, everything else is green

- **GIVEN** a run where only the Windows job fails
- **WHEN** the gate is evaluated
- **THEN** the run is green, and the Windows result is still visible

## Requirement: a test harness that extracts code must bring what that code needs

When a test extracts a function from a shipping script, it MUST extract that function's
dependencies too, recursively.

Extracting `Fail` alone left it interpolating a helper defined further down the file, so
PowerShell threw while building the arguments — before reaching the call under test — and the
function's own `catch { }` swallowed it. The test then failed on a missing file, naming
nothing.

### Scenario: the extracted function calls another one

- **GIVEN** a function whose body references another function in the same script
- **WHEN** the harness extracts it
- **THEN** the referenced function is extracted as well, and so is anything it references

### Scenario: telling a throw from a collapse

- **GIVEN** a script whose `catch` handles a thrown error
- **WHEN** the test asserts on the outcome
- **THEN** it distinguishes "threw and was caught" from "the script fell over", rather than
  accepting one exit status that both produce

## Requirement: a test that needs an absent tool must not pass silently

A test whose assertions hold on any platform MUST NOT be written so that it only executes
where a platform-specific tool exists.

`plutil` is macOS-only, so "macOS: …" meant "nowhere" before CI. A skip is indistinguishable
from a pass in the summary.

### Scenario: the generated plist

- **GIVEN** a generated XML file
- **WHEN** the test checks it
- **THEN** it asserts on the file directly, and uses the platform parser as a cross-check only
  where that parser exists

### Scenario: comparing paths written by two different tools

- **GIVEN** a path written into the file by a bash helper, and an expectation built with
  `path.join`
- **WHEN** they are compared on Windows
- **THEN** the comparison is of what is under test — substitution and escaping — not of two
  correct spellings of the same directory

## Requirement: a fallback must not assume the losing branch is quiet

Where two forms of a command are tried in turn, the result MUST be validated rather than the
first form assumed to fail silently.

`stat -f` is "format string" on BSD and `--file-system` on GNU, so on Linux it prints a
filesystem report to stdout before exiting non-zero, and `A || B` appends B's answer beneath
it. `2>/dev/null` covers stderr only.

### Scenario: GNU stat

- **GIVEN** a platform where `stat -f %m` prints to stdout and then fails
- **WHEN** the file's age is computed
- **THEN** the result is an integer, and the filesystem report never reaches the caller

### Scenario: BSD stat

- **GIVEN** a platform where only `stat -f %m` works
- **WHEN** the file's age is computed
- **THEN** the result is an integer

## Requirement: clearing a leaked reclaim marker verifies what it took

After winning the move-aside of a `.reclaim` marker, a process MUST confirm the file it moved
was the stale one it measured, and stand down otherwise.

Winning the rename does not establish that. Another process can win the same move, clear it,
and create its own fresh marker in between, and the rename then succeeds on that one — so two
processes end up inside the reclaim section, where the age re-read only protects the first
one's new lock once that lock exists.

### Scenario: the marker turned out to be somebody's live one

- **GIVEN** a `.reclaim` marker measured as stale but fresh by the time it is renamed
- **WHEN** the mover inspects what it took
- **THEN** it stands down without deleting the lock

## Known limits

- GitHub's Windows runner ships Git Bash and a looser execution policy than an ordinary
  client, so "the user's own security settings block the script" is not observable here. That
  still depends on the self-check reports.
- Fixing `lock_age_seconds` makes the stale-lock reclaim path reachable on Linux for the
  first time, and it brings a pre-existing race with it. `a leaked reclaim marker does not let
  two shell hooks into the critical section` fails intermittently under CPU pressure —
  measured 1 in 40 runs in a one-CPU container, and on both ubuntu legs in CI. macOS has
  always taken this path and passes, so the race is not new — only newly visible.

  One window of it is closed by the requirement above, mutation-verified on both
  implementations. The rest is not: the shell case still fails 1-2 times in 60 on a one-CPU
  container. Traced, and it is a different window — four processes become reclaimer in turn,
  each of them legitimately, because the first removes the marker as soon as it is done and
  the next sees "no marker, lock still stale" and takes over by the rules. Closing that means
  changing the protocol, and `shared/update-lock.js` already states that delete-and-recreate
  cannot be made atomic and that the implementation only bounds the window. Measured and
  written down rather than redesigned as a side effect of a `stat` fix.
- The Windows leg does not gate. Until its 109 pre-existing failures are cleared, a Windows
  regression can merge.
