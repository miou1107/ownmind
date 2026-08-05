# v1.26.67 — Three copies of "which tool is hosting this MCP", one of them wrong

The MCP answers the question "which AI tool am I running inside" in three places, with
two different rules.

| Site | Rule |
|---|---|
| `mcp/index.js:258` (`TOOL_NAME`) | `OWNMIND_TOOL` → `OWNMIND_CLIENT_TOOL` → `claude-code` |
| `mcp/ownmind-log.js:11` (`TOOL_NAME`) | same |
| `mcp/index.js:176` (`CLIENT_TOOL`) | **`OWNMIND_CLIENT_TOOL` → `claude-code`** |

The third drops `OWNMIND_TOOL`, and `OWNMIND_TOOL` is the variable the installer actually
writes. `install.sh` sets `OWNMIND_TOOL: 'cursor'` in the Cursor MCP config (lines 577
and 594). Nothing in this repository sets `OWNMIND_CLIENT_TOOL` at all, despite the
comment at `mcp/index.js:174` instructing users to set it.

`CLIENT_TOOL` is not the minor one. It is used for:

- the MCP heartbeat's `tool` (`index.js:352` and `:1747`)
- the `x-ownmind-tool` header on every API request (`:365`)
- the session log body (`:1119`)

So a correctly-configured Cursor MCP still reports its heartbeat as `claude-code`. And
`collector_heartbeat` is `UNIQUE (user_id, tool)`, so that write lands on top of the row
the claude-code scanner maintains, replacing its machine, version and `os`.

The comment above `ownmind-log.js`'s copy states it is "Aligned with the CLIENT_TOOL
design at mcp/index.js:167". It is not aligned; that is the defect. This is the same
species as v1.26.65's `catch { /* baseDir does not exist */ }` — a comment asserting a
property the code does not have, which then survives review because the comment is read
instead of the code.

## How this surfaced

Tracing why Antigravity usage was invisible on 2026-08-05. It turned out not to be the
cause there — measured on Vin's Mac, no OwnMind MCP process is running under Antigravity
at all, so its memory comes from the rules file the installer writes
(`~/.antigravity/rules/ownmind.md`) and it makes no API calls. But reading the
attribution code to rule that out exposed the divergence.

## The fix

One exported function in `shared/helpers.js`, used by all three sites, plus a test that
fails if a fourth copy appears. The duplication is the defect; removing one wrong copy
without removing the duplication leaves the next one free to drift.

Behaviour changes only for a process that has `OWNMIND_TOOL` set and
`OWNMIND_CLIENT_TOOL` unset — which is exactly the Cursor configuration the installer
writes, and exactly the case that is wrong today. A plain Claude Code install sets
neither and still resolves to `claude-code`, unchanged.

## Not in scope

**Making Antigravity visible at all.** It has no MCP wiring, and its two components
split the evidence: the editor writes VSCode telemetry the collector reads, the agent
manager writes nothing the collector can see. Recorded in `openspec/BACKLOG.md` rather
than guessed at here.

**Changing the `claude-code` fallback to `unknown`.** v1.18.4 deliberately moved it the
other way to stop `activity_logs` filling with `unknown`. Reversing that needs its own
argument and its own change.
