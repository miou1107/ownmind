# v1.26.41 — Spec: root dependency version floors

> Companion to `proposal.md`. Observable behaviour in GIVEN / WHEN / THEN form.

---

## Requirement 1 — A version floor SHALL be compared numerically

Text comparison MUST NOT be used. `4.10.0` is above `4.9.0`.

### Scenario 1.1 — below the floor

- **GIVEN** an installed version of `4.1.1` and a floor of `4.3.0`
- **WHEN** the two are compared
- **THEN** the floor is not met

### Scenario 1.2 — at or above the floor

- **GIVEN** an installed version of `4.3.0`, `4.3.1`, `4.4.0`, or `5.0.0` and a
  floor of `4.3.0`
- **WHEN** each is compared
- **THEN** the floor is met in every case

### Scenario 1.3 — a multi-digit segment

- **GIVEN** an installed version of `4.10.0` and a floor of `4.9.0`
- **WHEN** the two are compared
- **THEN** the floor is met
- **AND** the reverse comparison does not meet the floor

### Scenario 1.4 — a prerelease of the floor release

- **GIVEN** an installed version of `4.3.0-rc.1` and a floor of `4.3.0`
- **WHEN** the two are compared
- **THEN** the floor is not met, because a prerelease ranks below its release
- **AND** build metadata such as `4.3.0+build.7` is not treated as a prerelease

---

## Requirement 2 — Anything unreadable SHALL count as below the floor

A guard that cannot tell MUST choose the harmless outcome. Reinstalling is
idempotent; skipping leaves a vulnerable copy in place.

### Scenario 2.1 — the package is not installed

- **GIVEN** an OwnMind directory with no `node_modules/<pkg>`
- **WHEN** the floor is checked
- **THEN** the floor is not met

### Scenario 2.2 — the manifest is unusable

- **GIVEN** an installed package whose `package.json` is invalid JSON, or has no
  `version` field
- **WHEN** the floor is checked
- **THEN** the floor is not met

### Scenario 2.3 — either side is unparseable

- **GIVEN** an installed version or a floor that is `null`, empty, `latest`,
  `4.3`, or any non-semver string
- **WHEN** the two are compared
- **THEN** the floor is not met

---

## Requirement 3 — The CLI SHALL be usable as a shell predicate

Both update scripts branch on the exit status, so the contract MUST be exit
status only, and it MUST have exactly two outcomes. An earlier draft of this
requirement listed two while the implementation had three, the third being "the
CLI body did not execute", which silently landed on 0 and meant "floor met". A
review found the bug; this requirement is written to make it a test failure.

### Scenario 3.1 — exit status carries the answer

- **GIVEN** the helper invoked as `dep-floor-cli.mjs <dir> <pkg> <floor>`
- **WHEN** the floor is met
- **THEN** it exits 0
- **AND** when the floor is not met, it exits 1
- **AND** there is no third outcome: the CLI body always runs, because it lives in
  its own file and performs no "was I invoked directly?" check

### Scenario 3.2 — silence on stdout

- **GIVEN** any successful invocation
- **WHEN** stdout is captured
- **THEN** it is empty, so a PowerShell caller's return value is the boolean alone
  and not an array with stray output prepended

### Scenario 3.3 — missing arguments

- **GIVEN** the helper invoked with fewer than three arguments
- **WHEN** it runs
- **THEN** it exits 1 and prints usage to stderr, rather than reporting success

### Scenario 3.4 — a symlinked invocation path

- **GIVEN** the helper reached through a path where any component is a symlink,
  such as a relocated `~/.ownmind`
- **WHEN** it is invoked with a floor the installed version cannot meet
- **THEN** it exits 1, exactly as through the real path
- **AND** when invoked with a floor that is met, it exits 0
- **BECAUSE** comparing the invocation path against the module's own path is
  lexical on one side and realpath-resolved on the other, so a mismatch would
  skip the body, exit 0, and permanently mark the dependency as up to date

### Scenario 3.5 — an unexpected error

- **GIVEN** any exception escaping the comparison
- **WHEN** the CLI runs
- **THEN** it exits 1, so no failure mode reports "floor met" by accident

---

## Requirement 3b — The library module SHALL have no side effects on import

Splitting the CLI out is what removes the failure class in Scenario 3.4, so the
split MUST be preserved.

### Scenario 3b.1 — importing runs nothing

- **GIVEN** `dep-floor.mjs`
- **WHEN** it is imported by a test
- **THEN** no process exits and no argument parsing occurs

### Scenario 3b.2 — the scripts call the CLI, not the library

- **GIVEN** `scripts/update.sh` and `scripts/update.ps1`
- **WHEN** their source is read
- **THEN** each references `dep-floor-cli.mjs`
- **AND** neither references `dep-floor.mjs`

---

## Requirement 4 — The update scripts SHALL gate on version, not on existence

This is the defect being fixed and MUST NOT come back.

### Scenario 4.1 — the guard consults the helper

- **GIVEN** `scripts/update.sh` or `scripts/update.ps1`
- **WHEN** the source is read
- **THEN** it invokes `install-helpers/dep-floor-cli.mjs`
- **AND** it contains no reference to `node_modules/<pkg>` for any root dependency
  it installs

### Scenario 4.2 — an already-installed old version is upgraded

- **GIVEN** `~/.ownmind/node_modules/js-yaml` present at version `4.1.1`
- **WHEN** the shell guard as shipped is run against that tree
- **THEN** the install is performed, where the previous guard would have skipped it

### Scenario 4.3 — an up-to-date install is left alone

- **GIVEN** `~/.ownmind/node_modules/js-yaml` present at `4.3.0` or above
- **WHEN** the shell guard as shipped is run against that tree
- **THEN** no install is performed

### Scenario 4.4 — the polarity is pinned

- **GIVEN** the shell guard negates the exit status and the PowerShell guard
  compares it with `-ne 0`
- **WHEN** either is inverted
- **THEN** a test fails
- **BECAUSE** inversion is the one mutation that leaves the floors, the ranges, and
  the manifest all consistent while installing exactly when it should skip

### Scenario 4.5 — the guard's own log directory exists

- **GIVEN** the shell guard redirects node's stderr into `~/.ownmind/logs/`
- **WHEN** `scripts/update.sh` is read
- **THEN** it creates that directory before the guard is defined
- **BECAUSE** a failed redirect makes the whole command fail, the negation flips,
  and the install reruns on every sync forever. The beacon above it only creates
  the directory on its spool fallback, so its existence cannot be assumed

---

## Requirement 5 — The declared floor, the checked floor, and the installed range SHALL agree

Three numbers describe the same requirement in three files. Drift between them
MUST fail a test rather than be discovered in production.

### Scenario 5.1 — the scripts are not behind the manifest

- **GIVEN** the floor each update script checks for a root dependency
- **WHEN** it is compared against the minimum `package.json` declares
- **THEN** the script's floor is at or above it

### Scenario 5.2 — the install cannot undershoot its own gate

- **GIVEN** the version range a script installs
- **WHEN** it is compared against the floor that script gates on
- **THEN** the range's minimum is at or above the gate, so the install cannot
  satisfy the gate's failure condition on every subsequent sync

### Scenario 5.3 — the advisory floor is pinned by name

- **GIVEN** `CVE-2026-59869`, which requires js-yaml 4.3.0
- **WHEN** `package.json` and `package-lock.json` are read
- **THEN** both resolve js-yaml at 4.3.0 or above

---

## Requirement 6 — Fixing the mechanism SHALL cover every dependency using it

A fix applied only to the package with an advisory MUST NOT leave the same trap
set for the next one.

### Scenario 6.1 — both root dependencies move

- **GIVEN** `js-yaml` (which has an advisory) and `node-machine-id` (which does
  not)
- **WHEN** the update scripts are read
- **THEN** both are gated on a version floor
