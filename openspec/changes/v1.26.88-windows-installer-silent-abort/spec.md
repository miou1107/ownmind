# v1.26.88 — Spec

## Requirement: paths interpolated into inline Node source must be Windows-native

Any filesystem path that appears inside the *source text* of a `node -e` or `node -p`
invocation in a shell installer MUST have been passed through `to_win_path` from
`scripts/install-helpers/path-helpers.sh`.

Paths passed as command-line **arguments** (`node helper.cjs "$FILE"`) are out of scope:
the MSYS runtime converts those, and the existing argv call sites are known to work on
the reporting machine.

`install.sh` and `scripts/update.sh` MUST source `path-helpers.sh` and MUST fall back to
an identity `to_win_path` if the file is absent, so a partially-synced checkout still
runs.

### Scenario: Git Bash writes the Claude settings file

- **GIVEN** Git Bash on Windows where `$HOME` is `/c/Users/Vin`
- **WHEN** `install.sh` configures the PreToolUse hook
- **THEN** the path embedded in the Node source is `C:/Users/Vin/.claude/settings.json`
- **AND** the block completes rather than aborting with `ENOENT`

### Scenario: macOS is unaffected

- **GIVEN** a machine with no `cygpath` on `PATH`
- **WHEN** `to_win_path` is called with any path
- **THEN** it returns that path byte-for-byte unchanged

### Scenario: the helper is missing

- **GIVEN** `scripts/install-helpers/path-helpers.sh` does not exist
- **WHEN** `install.sh` runs
- **THEN** `to_win_path` is defined as an identity function and the script proceeds

## Requirement: an installer must never discard a Node error stream

No `node -e` or `node -p` invocation in `install.sh` or `scripts/update.sh` may redirect
stderr to `/dev/null`. Errors go to an install log; a non-zero exit prints a one-line
summary naming that log.

### Scenario: the settings file is unreadable

- **GIVEN** `~/.claude/settings.json` contains malformed JSON
- **WHEN** the hook-configuration block runs
- **THEN** the parse error is written to the install log
- **AND** the terminal shows a line naming the failing step and the log path

## Requirement: the upgrade log must survive rollback

`interactive-upgrade.sh` MUST write its log outside the directory that `rollback()`
replaces, and every message that refers the user to a log MUST name the surviving path.

### Scenario: install.sh fails and the upgrade rolls back

- **GIVEN** an upgrade whose `install.sh` step exits non-zero
- **WHEN** `rollback()` has restored the backup over `~/.ownmind`
- **THEN** the log file still exists and is non-empty
- **AND** it contains the stderr of the step that failed

## Requirement: a truncated install must report itself as failed

After `install.sh` completes, it MUST assert that the artifacts its later sections create
are present. A missing artifact MUST produce a `[FAIL]` line and a non-zero exit, and MUST
be visible in the self-check report so it reaches the v1.26.87 alerting.

The asserted set MUST be derived from the artifacts the script installs, not hand-listed
in a second place that can drift.

### Scenario: the script aborts before the SessionStart hook step

- **GIVEN** `install.sh` exits before `ensure-session-hook.cjs` runs
- **WHEN** the artifact assertion executes
- **THEN** it names the missing hook and exits non-zero

### Scenario: an incomplete install must not be rolled back

- **GIVEN** `interactive-upgrade.sh` invoking `install.sh`
- **WHEN** `install.sh` reaches its end and the artifact assertion fails
- **THEN** it exits 2, distinct from any other failure
- **AND** the caller reports the condition and does NOT call `rollback()`
- **AND** any other non-zero exit still rolls back

Rationale: `rollback()` replaces `${OWNMIND_DIR}` and nothing else, while `install.sh` has
already rewritten `~/.claude/settings.json`, the hook scripts, the skill files and git's
`core.hooksPath`. Rolling back would pair old code with new configuration, and it cannot
produce the missing artifacts either way.

### Scenario: the two Windows installers produce different files

- **GIVEN** a machine installed by `install.ps1`, which registers the Node hooks
- **WHEN** the artifact check runs
- **THEN** the Node implementation satisfies the hook artifacts
- **AND** `hooks/lib` is required only when the bash SessionStart hook is the one installed

### Scenario: HOME is supplied, not inferred

- **GIVEN** Git Bash where `$HOME` and `USERPROFILE` differ
- **WHEN** `install.sh` runs the artifact check
- **THEN** it passes `--home "$HOME"` and the check uses it

### Scenario: version alone is not treated as proof

- **GIVEN** a machine whose `package.json` reports the current version
- **AND** whose SessionStart hook was never installed
- **WHEN** the self-check runs
- **THEN** the install-completeness item reports `fail`, not `pass`

## Requirement: the guard list is derived, never hand-written

A test MUST parse `install.sh` and `scripts/update.sh`, locate every inline Node
invocation, and fail if any of them interpolates a shell variable holding a path without
`to_win_path`, or redirects stderr to `/dev/null`.

The guard covers every shell script in the repository, discovered with `git ls-files`, not
a list maintained by hand. A variable is cleared only by an assignment in the same file
that passes it through `to_win_path` — never by its name.

### Scenario: someone adds a new unconverted block

- **GIVEN** a new `node -e` block interpolating `'$SOME_CONFIG'`
- **WHEN** the test suite runs
- **THEN** it fails, naming the file and line

### Scenario: the block uses a different spelling of the flag

- **GIVEN** a `node --eval "…"` block interpolating a path
- **WHEN** the test suite runs
- **THEN** it fails — `-e`, `-p`, `--eval` and `--print` are all recognised

### Scenario: an already-shipped fix is reverted

- **GIVEN** an interpolated path whose `to_win_path` assignment is removed
- **WHEN** the test suite runs
- **THEN** it fails, with no name-based exemption able to hide it

### Scenario: a block cannot be parsed

- **GIVEN** an inline Node invocation whose closing quote the parser cannot locate
- **WHEN** the test suite runs
- **THEN** it fails rather than silently skipping that block
