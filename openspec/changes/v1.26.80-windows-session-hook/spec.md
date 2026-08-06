# v1.26.80 — Spec

## ADDED Requirement: the SessionStart command is decided in one place

`scripts/install-helpers/session-hook-command.cjs` SHALL be the only source of the command
string written into `settings.json`. `install.sh`, `install.ps1`, `scripts/update.sh` and
`scripts/update.ps1` all read it; none may carry its own copy.

Four copies existed before, two of them disagreed, and the one that ran daily won.

### Scenario: Windows

- **GIVEN** `platform === 'win32'`
- **THEN** the command is `node "<hookDir>/ownmind-session-start.js"` — absolute, forward
  slashes, quoted
- **AND** it contains no `bash` and no `~`

Quoted because Windows home directories routinely contain a space. Forward slashes so the
string survives JSON without backslash escaping. Node rather than bash because
`Get-Command bash` on Windows 10/11 finds `System32\bash.exe`, the WSL launcher, whose `~`
is a different home directory — the command runs, finds nothing, and fails silently.

### Scenario: macOS and Linux

- **GIVEN** any non-Windows platform
- **THEN** the command is exactly `bash ~/.claude/hooks/ownmind-session-start.sh`

Unchanged, deliberately. 12,221 successful hook loads over 90 days run through this exact
string.

### Scenario: all four matchers, always

- **WHEN** entries are written
- **THEN** there SHALL be one per matcher: `startup`, `resume`, `clear`, `compact`

A hook registered only for `startup` does not fire on resume, clear or compact, and the AI
then continues without the user's iron rules loaded. `install.ps1` previously wrote a
single matcher-less entry, which is what made the update script tear it down.

## ADDED Requirement: an existing installation is repaired, not just new ones

The update scripts SHALL rewrite the entries when the command differs from the one this
platform should have, independently of whether the matchers are complete.

### Scenario: the state every affected machine is actually in

- **GIVEN** Windows, four entries, all four matchers present, every command `bash …`
- **THEN** `needsRewrite` returns true and all four are replaced

Judging by matcher completeness alone reports these machines healthy. The release would
then ship and repair none of the six.

### Scenario: already correct

- **GIVEN** entries that already match what this platform should have
- **THEN** nothing is written

The update runs daily; a rewrite every time would churn `settings.json` forever.

### Scenario: the user edited the command themselves

- **GIVEN** any command we did not generate (`isGeneratedCommand` is false), e.g.
  `bash ~/.claude/hooks/ownmind-session-start.sh --verbose`
- **THEN** it is left alone

Otherwise the installer silently undoes a deliberate edit on every update and the user has
no way to win. `~/.ownmind/.no-session-hook` remains the way to opt out entirely.

### Scenario: the helper is not on disk yet

- **GIVEN** `session-hook-command.cjs` cannot be required — the update that delivers it, or
  a half-finished `git pull`
- **THEN** the SessionStart block is skipped and `settings.json` is left untouched
- **AND** every other hook in the same script still installs

An uncaught `MODULE_NOT_FOUND` would kill the whole node script and take PreToolUse, Stop
and WorktreeCreate with it.

## MODIFIED Requirement: Windows keeps the Node hook file current

`scripts/update.ps1` SHALL refresh `ownmind-session-start.js` and
`ownmind-iron-rule-check.js` into `~/.claude/hooks`, naming them explicitly.

### Scenario: a Windows user updates

- **WHEN** the sync runs
- **THEN** the Node hooks are copied alongside the `*.sh` ones

It previously synced only `*.sh`, so the file the Windows command points at stayed frozen
at whatever shipped on install day. Same shape as the scheduler defect in v1.26.79:
correct at install, maintained by nothing afterwards.

Named individually rather than globbing `*.js`, because the other `.js` files under
`hooks/` are meant to run from `~/.ownmind` and do not belong in the hook directory.
