# Spec — the monitor mod is loaded from the OwnMind checkout on every machine

## Requirement 1 — install and every update point Claude Code at the mod

### Scenario: no settings file

- **GIVEN** `~/.claude/settings.json` does not exist
- **WHEN** the helper runs
- **THEN** it MUST create it with `env.CLAUDE_CODE_PLUGIN_DIRS` = the checkout's
  `mods/ownmind-monitor` and `env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` = `"1"`

### Scenario: other settings exist

- **GIVEN** a settings file with other keys and other `env` variables
- **THEN** every other key and variable MUST be kept unchanged, key order included

### Scenario: another plugin folder is listed

- **GIVEN** `CLAUDE_CODE_PLUGIN_DIRS` already names another folder
- **THEN** that folder MUST be kept, before ours, joined with the platform separator

### Scenario: run twice

- **WHEN** the helper runs a second time
- **THEN** it MUST report `unchanged` and MUST NOT rewrite the file

### Scenario: existing machines

- **GIVEN** a machine installed before this version
- **WHEN** its auto-update pulls this version and runs `update.sh` / `update.ps1`
- **THEN** the helper MUST run, so the machine gets the mod without a reinstall

## Requirement 2 — the mod is never loaded twice

### Scenario: hand-installed copy

- **GIVEN** `CLAUDE_CODE_PLUGIN_DIRS` contains `~/.claude/mods/ownmind-monitor`, in tilde or
  expanded form, with or without a trailing slash
- **THEN** that entry MUST be replaced, in the same position, by the checkout's path

### Scenario: same path spelled twice

- **GIVEN** the checkout's path appears in two spellings
- **THEN** the result MUST contain it once

## Requirement 3 — Windows

### Scenario: separator and path form

- **GIVEN** the platform is Windows
- **THEN** folders MUST be joined with `;`, the path MUST be a native Windows path, and a
  drive-letter colon MUST NOT be treated as a separator
- **AND** a Git Bash path (`/c/Users/x/.ownmind`) MUST be converted to `C:\Users\x\.ownmind`
- **AND** the legacy entry MUST be recognised regardless of slash direction or letter case

### Scenario: the mod finds the home folder

- **GIVEN** `HOME` is unset or in Git Bash form and `USERPROFILE` is set
- **THEN** the mod MUST read `~/.ownmind/logs` and run git in `~/.ownmind` under `USERPROFILE`

## Requirement 4 — safety

- A settings file that does not parse, or is not a JSON object, MUST be left untouched and the
  helper MUST print `ERROR:monitor_mod:…` and exit 1.
- A UTF-8 BOM MUST be accepted.
- If the checkout has no mod folder, the helper MUST NOT add an entry, and MUST remove an
  existing entry for this mod (a rollback must not leave Claude Code pointing at nothing).
- An `env` that is not an object, or a `CLAUDE_CODE_PLUGIN_DIRS` that is not a string, MUST be
  refused with `ERROR:monitor_mod:…`, leaving the file untouched.
- With `~/.ownmind/.no-monitor-mod` present, the helper MUST remove only its own entry, and
  keep it removed on later runs.
