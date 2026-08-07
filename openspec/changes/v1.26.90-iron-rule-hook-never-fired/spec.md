# v1.26.90 — Spec

## Requirement: a hook must extract the command from the payload Claude Code sends

Both copies of the PreToolUse iron-rule hook MUST read the command from
`tool_input.command`, and MUST fall back to a top-level `command` so a hook invoked by
hand or by an older caller still works.

### Scenario: the real PreToolUse payload

- **GIVEN** `{ hook_event_name, tool_name: "Bash", tool_input: { command: "git commit …" } }`
- **WHEN** either hook runs with credentials configured
- **THEN** it detects the `commit` trigger and queries the iron-rule endpoint

### Scenario: the legacy bare payload

- **GIVEN** `{ command: "git commit …" }`
- **WHEN** either hook runs
- **THEN** it behaves exactly as before this change

### Scenario: a tool call with no command

- **GIVEN** a payload whose `tool_input` carries no `command` (a `Read` call, say)
- **WHEN** either hook runs
- **THEN** it prints nothing, exits 0, and does not contact the API

Rationale for the last clause: the empty-command guard runs before the credential read, so
"did the hook reach the API" is a content-independent signal that the command was
extracted. Asserting on reminder text would couple the test to rule data that changes.

## Requirement: no shipped script may read stdin through a POSIX-only path

No file tracked in this repository outside `tests/` and `docs/` may call
`readFileSync('/dev/stdin')`. Use fd 0, which is identical on POSIX and works on Windows.

The checked file list MUST be produced by `git ls-files`, so a new script with the same
defect is caught without anyone remembering to extend a list.

### Scenario: someone adds a new POSIX-only stdin read

- **GIVEN** a new hook calling `readFileSync('/dev/stdin')`
- **WHEN** the test suite runs
- **THEN** it fails, naming the file and line

### Scenario: the file listing breaks

- **GIVEN** `git ls-files` returns an implausibly short list
- **WHEN** the test suite runs
- **THEN** it fails rather than passing on an empty scan

## Requirement: a comment inside an inline Node block must not defeat the v1.26.88 guard

The v1.26.88 guard scans the source text of every inline `node -e` block for interpolated
shell variables. It cannot distinguish a comment from live source. Comments inside those
blocks MUST therefore not contain shell variable references, escaped or otherwise.

### Scenario: a comment mentions a shell variable

- **GIVEN** a `node -e` block whose comment contains `\$COMMAND`
- **WHEN** the test suite runs
- **THEN** `tests/installer-node-paths.test.js` fails, reporting it as unconverted

This is the guard behaving correctly — a scanner that fails closed on text it cannot
classify is the right trade. The fix is to reword the comment, not to teach the guard to
skip `//` lines: `//` also appears inside string literals, and a scanner that skips such
lines could be evaded.
