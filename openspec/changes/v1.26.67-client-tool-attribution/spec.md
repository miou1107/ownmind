# v1.26.67 — Spec

## Requirement 1 — One function answers "which tool is hosting this"

`resolveClientTool(env)` is exported from `shared/helpers.js` and is the only place the
rule is written.

### Scenario: the installer's variable wins

- **GIVEN** `OWNMIND_TOOL=cursor`
- **THEN** the result is `cursor`

### Scenario: the documented variable is honoured

- **GIVEN** `OWNMIND_CLIENT_TOOL=antigravity` and no `OWNMIND_TOOL`
- **THEN** the result is `antigravity`

### Scenario: both set

- **GIVEN** `OWNMIND_TOOL=cursor` and `OWNMIND_CLIENT_TOOL=windsurf`
- **THEN** the result is `cursor`, preserving the precedence `mcp/index.js:258` and
  `mcp/ownmind-log.js` already had

### Scenario: neither set

- **THEN** the result is `claude-code`, unchanged from today, so an ordinary Claude Code
  install is unaffected

### Scenario: set but empty

- **GIVEN** `OWNMIND_TOOL=''`
- **THEN** it is treated as unset rather than resolving to an empty tool name

An empty string reaching `collector_heartbeat.tool` would create a row no report groups
by and no human recognises.

## Requirement 2 — The MCP heartbeat carries the tool that is actually running

### Scenario: a Cursor MCP session

- **GIVEN** the Cursor MCP config the installer writes, which sets `OWNMIND_TOOL=cursor`
- **WHEN** the MCP sends its heartbeat
- **THEN** it is written against `tool='cursor'`

Before this change it was written against `claude-code`. `collector_heartbeat` is
`UNIQUE (user_id, tool)`, so that write replaced the machine, version and `os` of the
row the claude-code scanner maintains. Two tools on one machine were collapsing into
one row, and the row said whichever wrote last.

### Scenario: the request header and the session log

- **THEN** `x-ownmind-tool` and the session log body carry the same resolved value as
  the heartbeat, because all three read the one function

## Requirement 3 — One session reports one identity

The two rules did not split cleanly along "important" and "unimportant" calls. They
split across paths within the same session:

| Call | Used | A Cursor session sent |
|---|---|---|
| broadcast fetch, which writes `user_tool_last_seen` | `TOOL_NAME` | `cursor` |
| **emergency** session log | `TOOL_NAME` | `cursor` |
| heartbeat, `x-ownmind-tool`, **normal** session log, bug report | `CLIENT_TOOL` | `claude-code` |

### Scenario: the same session ending two different ways

- **GIVEN** a Cursor MCP session
- **WHEN** it ends normally
- **THEN** its session log said `claude-code`
- **AND WHEN** an identical session ends through the emergency path
- **THEN** its session log said `cursor`

One process reported two identities to the same server depending on how it shut down.
After this change every path reports the resolved value.

### Scenario: reading heartbeat rows across the upgrade

- **GIVEN** a user with `OWNMIND_TOOL` set whose mislabelled MCP heartbeat had been
  keeping their `claude-code` row fresh
- **WHEN** they upgrade
- **THEN** that row is maintained only by the actual claude-code scanner, and goes stale
  if they do not run Claude Code

This is the correct behaviour and it is also a trap for anyone diagnosing collector
silence, which is the exact activity that produced v1.26.65 and v1.26.66. A
`claude-code` row that stops moving right after an upgrade may mean the collector died,
or may mean it was never that user's claude-code collector writing it.

## Requirement 4 — A fifth copy cannot appear quietly

### Scenario: someone re-inlines the rule

- **GIVEN** a future edit that reads `OWNMIND_CLIENT_TOOL` or `OWNMIND_TOOL` directly
  outside `shared/helpers.js`
- **THEN** `tests/mcp-client-tool-attribution.test.js` fails

The defect was three copies drifting, not one wrong expression. Deleting the wrong copy
without preventing the next one leaves the same hole open.

### Scenario: the misleading comment

- **GIVEN** `mcp/ownmind-log.js` claimed to be "Aligned with the CLIENT_TOOL design at
  mcp/index.js:167" while not being aligned
- **THEN** no comment asserts alignment; the shared import makes it true by construction
