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
defect is caught without anyone remembering to extend a list. The scan MUST match against
whole file text, not line by line: the call and its argument can sit on separate lines.

### Scenario: the read is split across two lines

- **GIVEN** `readFileSync(` and `'/dev/stdin'` on separate lines
- **WHEN** the test suite runs
- **THEN** it still reports the offender

### Scenario: someone adds a new POSIX-only stdin read

- **GIVEN** a new hook calling `readFileSync('/dev/stdin')`
- **WHEN** the test suite runs
- **THEN** it fails, naming the file and line

### Scenario: the file listing breaks

- **GIVEN** `git ls-files` returns an implausibly short list
- **WHEN** the test suite runs
- **THEN** it fails rather than passing on an empty scan

## Requirement: restoring the hook must not switch on enforcement

The verification engine MUST report its failures and MUST NOT emit `decision: block`.

The conditions it evaluates come from the local rule cache, which the MCP layer overwrites
from the server on init and after every rule mutation. The stored data still carries
verification templates attached by the pre-v1.26.89 route, all of them `block_on_fail`. The
hook had never executed, so restoring it would switch on enforcement of conditions no user
authored, naming a rule unrelated to the operation.

The OwnMind version gate is the one exception: it is product logic rather than user data,
and it is scoped to the OwnMind checkout.

### Scenario: a cached rule marked block_on_fail fails its condition

- **GIVEN** a cached rule with `block_on_fail: true` whose condition cannot pass
- **WHEN** either hook runs against `git push`
- **THEN** the output names the failing rule
- **AND** carries no `decision: block`, so the command proceeds

### Scenario: git push outside the OwnMind checkout

- **GIVEN** a working directory that is a different git repository
- **WHEN** either hook runs against `git push`
- **THEN** the version gate does not fire

## Requirement: the extracted command must be a string

A `command` that is present but not a string MUST be treated as absent.

### Scenario: an array command that would match a trigger

- **GIVEN** `tool_input.command` is `["git commit -m x"]`
- **WHEN** either hook runs
- **THEN** it exits without contacting the API, rather than acting on the stringified value

## Requirement: the reminder must reach the model

A PreToolUse hook exiting 0 has its bare stdout shown only in transcript mode. Every
user-visible output path MUST use the `hookSpecificOutput` envelope, and a run with nothing
to say MUST print nothing at all rather than an empty envelope.

### Scenario: a matching rule on commit

- **GIVEN** the API returns a rule tagged `trigger:commit`
- **WHEN** the `.sh` hook runs
- **THEN** its stdout parses as JSON carrying `hookSpecificOutput.additionalContext`

### Scenario: an ordinary command

- **GIVEN** a command matching no trigger
- **WHEN** either hook runs
- **THEN** it prints nothing and makes no API call

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
