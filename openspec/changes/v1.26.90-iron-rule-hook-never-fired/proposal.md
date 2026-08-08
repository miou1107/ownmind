# v1.26.90 — Proposal: the pre-action iron rule reminder never fired

## Background

Found on a Windows 10 machine (Git Bash, node v25.8.1) while verifying the v1.26.88
installer fix. `hooks/ownmind-iron-rule-check.sh` is the PreToolUse hook `install.sh`
registers for every Bash call. Traced with `bash -x`, feeding it the payload Claude Code
actually sends:

```
+ COMMAND=
+ '[' -z '' ']'
+ exit 0
```

Two independent defects stack, and each on its own is enough to produce that trace.

### Defect 1 — a POSIX-only stdin path (Windows)

```js
const d = require('fs').readFileSync('/dev/stdin','utf8');
```

Windows node has no such path; it resolves against the drive root to `C:\dev\stdin` and
throws `ENOENT`. Three things make the throw invisible:

1. it happens **outside** the `try`, so the `catch` on the next line cannot see it
2. the whole invocation is wrapped in `2>/dev/null`
3. the surrounding `$( )` yields an empty string, and the hook's next line is
   `if [ -z "$COMMAND" ]; then exit 0; fi` — a successful exit

Same failure class as the `CLAUDE_SETTINGS` path fixed in v1.26.88, in a file v1.26.88
had already touched.

### Defect 2 — reading a field the payload does not have (every platform)

```js
JSON.parse(d).command
```

Claude Code sends `{ session_id, hook_event_name, tool_name, tool_input: { command } }`.
There is no top-level `command`. This half has nothing to do with Windows: on macOS the
stdin read succeeds, the extraction still returns `''`, and the hook still exits at the
empty-command guard.

Reproduced on macOS against the installed v1.26.89 hook:

- real payload (`tool_input.command`) → no output, exit 0
- bare `{ command }` → `【OwnMind v1.26.89】鐵律檢查：commit 操作，25 條規則已確認 ✓`

So the headline is not "Windows users saw no reminder". **Nobody has ever seen this
reminder, on any platform.** The `.js` sibling reads stdin correctly but carries the same
extraction, so it is equally dead.

`hooks/ownmind-tty-echo.cjs` already knew the payload is nested — it reads the top-level
`tool_response` and documents that two shapes are observed in practice. This hook never
caught up.

## Why it stayed hidden

Every symptom of this bug is an absence. A silent exit 0 from a PreToolUse hook is
indistinguishable from "no iron rule applies to this command", which is the common case.
Nothing in the self-check or the install-check reports covers "did the hook produce
output", so no telemetry contradicted the assumption that it worked.

## Proposal

1. Read fd 0 instead of `/dev/stdin` — portable, and identical on POSIX.
2. Prefer `tool_input.command`, fall back to a top-level `command` so manual invocation and
   any older caller keep working.
3. Change **both** copies. This repo has already shipped a fix to one of these two files
   and left the other broken (v1.26.87, the API envelope).
4. Pin both halves with a test that runs the real hooks, and a repo-wide scan for
   `/dev/stdin` whose file list is grown from `git ls-files`, not hand-maintained.

## Out of scope

The thirteen `2>/dev/null` redirects in this file. They are the reason the bug survived,
but a hook's stderr is consumed by Claude Code, so removing them needs a destination
designed first. Recorded as backlog item 30.
