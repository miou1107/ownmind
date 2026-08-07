# v1.26.92 — Spec

## Requirement: a file-editing tool call produces the `edit` trigger

Both copies of the PreToolUse iron-rule hook MUST derive a trigger from `tool_name` when
the payload carries no command. `Edit`, `Write`, `MultiEdit` and `NotebookEdit` MUST all
map to `edit`. The mapping MUST be case-sensitive on the tool names Claude Code actually
sends, and unknown tool names MUST yield no trigger.

The command path keeps priority: a payload carrying both a command and a tool name is
resolved by `detectCommandTrigger`, unchanged.

### Scenario: a real Edit payload

- **GIVEN** `{ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path, old_string, new_string } }`
- **WHEN** either hook runs with credentials configured and no reminder sent this window
- **THEN** it queries the iron-rule endpoint and lists the rules matching `edit`

### Scenario: a tool that does not change files

- **GIVEN** `{ tool_name: "Read", tool_input: { file_path } }`
- **WHEN** either hook runs
- **THEN** it prints nothing, exits 0, and does not contact the API

### Scenario: the Bash triggers are untouched

- **GIVEN** `{ tool_name: "Bash", tool_input: { command: "git commit -m x" } }`
- **WHEN** either hook runs
- **THEN** it resolves the `commit` trigger exactly as in v1.26.91, ignoring `tool_name`

## Requirement: the edit reminder is throttled to one full listing per hour

The full listing MUST be emitted on the first edit of a one-hour window. Every subsequent
edit in that window MUST emit a single line instead, carrying the rule count and the
occurrence number. The first edit after the window expires MUST start a new window and
emit the full listing again.

The window MUST be measured from the first edit in it, not from a fixed clock boundary, so
"this hour" means the hour that started when the listing was shown.

State lives at `~/.ownmind/state/edit-reminder.json` and MUST be overridable by an
environment variable so tests do not touch the user's real state. A missing, unreadable or
malformed state file MUST be treated as "no window open" — the failure mode is one extra
full listing, never a suppressed one.

### Scenario: second edit inside the window

- **GIVEN** a full listing was emitted 10 minutes ago and 2 edits have happened since
- **WHEN** another `Edit` payload arrives
- **THEN** the output is one line naming the same rule count and occurrence 4, and no
  request is made to the iron-rule endpoint

### Scenario: the window expires

- **GIVEN** the recorded window started 61 minutes ago
- **WHEN** an `Edit` payload arrives
- **THEN** the full listing is emitted again and the occurrence count restarts at 1

### Scenario: a corrupt state file

- **GIVEN** `edit-reminder.json` contains text that is not JSON
- **WHEN** an `Edit` payload arrives
- **THEN** the hook emits the full listing and rewrites the file, rather than exiting or
  suppressing the reminder

## Requirement: the one-line form names the AI as the party bound by the rules

The throttled line MUST identify the AI as the party the rules apply to, MUST carry the
rule count, and MUST NOT assert that the rules were followed.

A reader who sees a one-line reminder where a list stood a minute ago will ask whether the
system stopped working; the line carries the occurrence number so that question is
answered without them having to check.

### Scenario: the rendered line

- **GIVEN** 63 matching rules and occurrence 4
- **THEN** the line is
  `【OwnMind v1.26.92】AI 改檔案要遵守的鐵律 63 條 · 本小時第 4 次`

### Scenario: no compliance claim

- **GIVEN** any rule count and occurrence
- **THEN** the rendered line contains no wording asserting the rules were obeyed
  (`遵守中`, `已遵守`, `正在遵守`), because the hook cannot observe that

## Requirement: the edit trigger never blocks

An `edit` trigger MUST NOT emit `decision: block`, and MUST NOT run the verification
engine. The engine is the only path that can block, its conditions are written for commit
and deploy, and none of them can be satisfied by an edit.

### Scenario: a blocking rule is present in the cache

- **GIVEN** the rule cache holds a rule with `block_on_fail: true` whose condition cannot
  be satisfied
- **WHEN** an `Edit` payload arrives
- **THEN** the output carries `hookSpecificOutput` and no `decision` field

## Requirement: the installers register the hook for the editing tools

`install.sh` and `install.ps1` MUST register the hook under a matcher covering the editing
tools, in addition to the existing `Bash` matcher. Registration MUST be idempotent, so an
upgrade over an existing install neither duplicates the entry nor drops the Bash one.

### Scenario: upgrading an install that only has the Bash matcher

- **GIVEN** `settings.json` already contains the `Bash` PreToolUse entry for this hook
- **WHEN** the installer runs again
- **THEN** the editing-tool entry is added, the Bash entry is left as it was, and running
  the installer a second time adds nothing further
