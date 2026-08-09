# v1.26.105 — Spec

## Requirement: a registered PreToolUse command that differs is rewritten

Install and upgrade MUST compare the registered command against the one this version would
write, and rewrite it when they differ.

Presence MUST NOT be treated as correctness. A check of the form "does any command under
this matcher mention `ownmind-iron-rule-check`" is satisfied by the broken command itself,
so the entry that most needs repair is the one that never gets it.

### Scenario: the measured regression

- **GIVEN** a `Bash` entry whose command names `~/.claude/hooks/ownmind-iron-rule-check.js`
- **WHEN** the installer or updater runs
- **THEN** that command is rewritten to the checkout copy, and the entry is not duplicated

### Scenario: nothing to do

- **GIVEN** a `settings.json` whose entries already carry the correct commands
- **WHEN** the helper runs
- **THEN** the file is left byte-identical and no backup is written

### Scenario: a changing run is recoverable

- **GIVEN** a `settings.json` that will be modified
- **WHEN** the helper rewrites it
- **THEN** a backup is written before the change

### Scenario: both invocation styles

- **GIVEN** the helper is run in bash mode against a settings file holding a node command
- **WHEN** it repairs the entry
- **THEN** the command becomes the bash hook — the correct target depends on the platform,
  not on what happens to be there

## Requirement: the repair survives the platform it exists for

`settings.json` MUST be parsed when it carries a UTF-8 BOM.

PowerShell's default `Out-File -Encoding utf8` writes one, and `JSON.parse` rejects a BOM
outright — so without this the repair fails on Windows, which is the only platform where the
defect was measured.

### Scenario: BOM

- **GIVEN** a `settings.json` beginning with a UTF-8 BOM and a stale command
- **WHEN** the helper runs
- **THEN** the command is repaired

### Scenario: malformed JSON

- **GIVEN** a `settings.json` that does not parse
- **WHEN** the helper runs
- **THEN** it reports the problem and does not overwrite the file

## Requirement: nothing outside OwnMind's own entries is touched

Hooks and settings the user registered themselves MUST survive unchanged.

### Scenario: a user's own Bash hook

- **GIVEN** a `settings.json` with a user-authored `Bash` PreToolUse hook alongside OwnMind's
- **WHEN** the helper repairs OwnMind's entry
- **THEN** the user's hook and every unrelated setting are unchanged

## Requirement: the install check reads the command, not the directory

The `iron_rule_hook` artifact check MUST resolve the path named by the **registered**
PreToolUse command and assert that file exists.

Asking whether a copy exists somewhere under `~/.claude/hooks` is why a machine reported
`install_complete 6/6` while the registered command could not start. A copy on disk is not
evidence that the registered one runs.

### Scenario: a copy covers for a broken command

- **GIVEN** a copy of the hook under `~/.claude/hooks` and a registered command naming a
  different file that does not exist
- **WHEN** the artifact check runs
- **THEN** it fails

### Scenario: the registered file is the one that is there

- **GIVEN** a registered command naming a file that exists
- **WHEN** the artifact check runs
- **THEN** it passes

### Scenario: `~`-relative bash command

- **GIVEN** a command of the form `bash ~/.claude/hooks/ownmind-iron-rule-check.sh`
- **WHEN** the path is resolved
- **THEN** `~` resolves against home, and the interpreter name is not swallowed into the path

### Scenario: nothing registered yet

- **GIVEN** a `settings.json` with no OwnMind PreToolUse entry
- **WHEN** the artifact check runs
- **THEN** it falls back to the previous candidate-list behaviour

## Requirement: the registered hook's first import must resolve

When a `.js` command is registered, the check MUST also assert that `../shared/helpers.js`
resolves relative to it.

Existing is not starting. On the machine measured on 2026-08-09 the registered file **was**
present — the two copies are byte-identical — and the hook still died on every Bash call,
because that import resolved into `~/.claude/shared/`, a directory no installer creates. An
ESM import that cannot resolve kills node before the first byte of the payload runs, so this
is the difference between registered and running.

### Scenario: the measured machine

- **GIVEN** a registered `.js` command naming a file that exists, whose sibling
  `../shared/helpers.js` does not
- **WHEN** the artifact check runs
- **THEN** `iron_rule_hook` passes and `iron_rule_hook_deps` is reported missing

### Scenario: the bash hook

- **GIVEN** a registered `.sh` command
- **WHEN** the artifact check runs
- **THEN** no dependency is demanded — that hook imports nothing

## Requirement: one implementation, called by all four scripts

`install.sh`, `install.ps1`, `scripts/update.sh` and `scripts/update.ps1` MUST delegate
PreToolUse registration to `scripts/install-helpers/ensure-pretooluse-hooks.cjs` and MUST NOT
hold an inline copy of that logic.

Four copies is how this broke: only the bash one was reachable from CI, and the half that
rotted is the half no test could touch.

### Scenario: no inline copies remain

- **GIVEN** each of the four scripts
- **WHEN** its text is inspected
- **THEN** it calls the helper and contains no inline registration block, matched by that
  script's own language — PowerShell's copy used `PreToolUse +=` and never `.push(`, so one
  JS-shaped pattern passes `install.ps1` vacuously, in the one file this change exists
  because CI cannot reach it

## Requirement: a helper failure is reported, never fatal

A shell script running under `set -e` MUST NOT invoke the helper as a bare command
substitution.

`VAR=$(cmd)` carries `cmd`'s exit status, so one non-zero exit — an unreadable
`settings.json`, a locked file on Windows — aborts the whole installer at that line, and
everything below it, including the artifact self-check, never runs. With `2>&1` captured into
a variable the failure path never echoes, it aborts silently.

### Scenario: the helper exits non-zero

- **GIVEN** a `settings.json` the helper cannot parse
- **WHEN** the installer reaches the PreToolUse step
- **THEN** the failure is printed and the installer continues to its remaining steps

## Requirement: health is reported after the repairs, not before

The updaters MUST invoke the self-check after every step that repairs the things it reports
on.

`install_complete` now includes the registered hook's dependency, so a self-check running
ahead of the repair uploads a failure the same run then fixes — one alert per affected
machine, about a state that no longer exists by the time anybody reads it. `install.sh` has
always run its artifact check at the tail for this reason; the updaters ran theirs in section
2d, ahead of every repair in section 3.

### Scenario: an upgrade that repairs a stale command

- **GIVEN** a machine whose registered PreToolUse command is the broken one
- **WHEN** the updater runs
- **THEN** the command is repaired first, and the health report describes the repaired machine

## Requirement: an upgrade does not judge its own runtime files as user edits

`.gitignore` MUST cover the files the installers and hooks write into the checkout at
runtime.

Untracked files make `git status --porcelain` non-empty; interactive-upgrade reads that as a
dirty tree and answers with `git reset --hard`. The overwrite is not the expensive part —
the warning becoming noise on every single run is, because an edit the user actually made
scrolls past inside the same message.

### Scenario: a clean install after an upgrade

- **GIVEN** a checkout on which the installers have written `.node-path`, `.git-bash-path`,
  `.last-mcp-update-check`, `.session-hook-installed`, `cache/` and `git-hooks/`
- **WHEN** upgrade inspects the tree
- **THEN** it is not judged dirty on account of those files

## Known limits

- The helper repairs what is registered. A machine with no `settings.json` at all, or one
  Claude Code cannot read, is outside its reach — other artifacts already speak to that.
- Matching the registered command is textual: it recognises a quoted path first, then a
  whitespace-delimited token. A command built by an unusual shell construct that hides the
  path from both would read as "nothing registered" and fall back to the candidate list.
