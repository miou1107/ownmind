# Spec — one classifier, not two

## Requirement: a command is classified in exactly one place

`detectCommandTrigger()` in `shared/helpers.js` is the only implementation. Every entry
point reaches it:

| Entry point | Route |
| --- | --- |
| `hooks/ownmind-iron-rule-check.js` | imports it directly |
| `hooks/ownmind-iron-rule-check.sh` | pipes the command into `hooks/ownmind-detect-trigger.js`, which calls it |
| MCP `report_compliance` | `detectTriggerFromContext()`, a different question (free text, not a command) |

Adding a pattern to `detectCommandTrigger()` changes every platform at once. There is no
second list.

### Scenario: a pattern is added

- **WHEN** a new command shape is added to `detectCommandTrigger()`
- **THEN** the shell hook classifies it identically, with no shell-side edit
- **AND** `tests/iron-rule-trigger-parity.test.js` passes without being updated for it

## Requirement: the wrapper reads the command whole

`hooks/ownmind-detect-trigger.js` takes the command on stdin.

### Scenario: a multi-line commit message

- **WHEN** the command is `git commit -m "line one\nline two"`
- **THEN** the whole command reaches `detectCommandTrigger()` and classifies as `commit`

### Scenario: run by hand

- **WHEN** invoked as `node ownmind-detect-trigger.js "git tag v1"` with no pipe
- **THEN** argv is used and stdin is not read, so it does not block on a terminal

### Scenario: no command at all

- **WHEN** stdin is empty or absent
- **THEN** it prints an empty line and exits 0 — "no trigger" is an answer, not a failure

## Requirement: a broken classifier is loud

The shell hook checks the wrapper's exit status and does not redirect its stderr.

### Scenario: the wrapper cannot run

- **WHEN** `node` cannot load `hooks/ownmind-detect-trigger.js`
- **THEN** node's error reaches stderr rather than being discarded
- **AND** the hook writes `detect_trigger_failed` with the exit status to the activity log
- **AND** the hook still exits 0, because a hook must never fail the command it inspects

This matters because the failure mode is quiet by nature: a missing classifier produces no
trigger for any command, which looks exactly like an ordinary day with no risky commands in
it. The first run after this change had precisely that shape — every command came back
`null` — and only the parity test distinguished it from success.

## Requirement: the installers ship the wrapper

`HOOK_JS_FILES` in `install.sh` and `$GitHookJsFiles` in `install.ps1` both name
`ownmind-detect-trigger.js`.

On a standard install these lists are inert: `OWNMIND_DIR` is `$HOME/.ownmind`, so source
and destination are the same file and the copy is skipped. What puts the helpers on disk is
the git checkout. The lists still govern a clone anywhere else, and a name missing from one
fails quietly rather than loudly.

## Requirement: one staged home for the shell-hook tests

`tests/helpers/hook-home.js` exports `stageHookHome({ apiUrl, apiKey, version })` and owns
the list of helpers the shell hook runs by absolute path.

### Scenario: a new helper is added to the hook

- **WHEN** the shell hook starts running a new `node "$HOME/.ownmind/hooks/…"` helper
- **THEN** adding it to `HOOK_HELPERS` is sufficient for all five test files

This exists because the alternative was measured. Pointing the hook at a new helper broke
eight tests across four files, every one of them for the same missing symlink — the same
class of defect this whole change removes, one layer down.
