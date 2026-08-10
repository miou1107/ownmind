# v1.26.127 — Spec

## Requirement: one tip list, two consumers

`shared/tips.js` MUST be the only place a tip text is written. `mcp/index.js` MUST take its
tip from that module, and the operations manual in `src/routes/memory.js` MUST render the
pool from it rather than restating the entries.

### Scenario: a tip is edited

- **GIVEN** an entry in `shared/tips.js` is reworded
- **WHEN** an MCP client and an API client each ask OwnMind for a tip
- **THEN** both can only see the new wording, because neither holds its own copy

### Scenario: a copy is reintroduced

- **GIVEN** any tip text is pasted back into `mcp/index.js`, `src/routes/memory.js` or a
  config template
- **WHEN** the suite runs
- **THEN** it fails, naming the file and the duplicated tip

## Requirement: every tip is anchored to something that exists

Each entry MUST carry an anchor that is either an MCP tool name `mcp/index.js` registers, or
`file:<path>` for a repo file that exists.

### Scenario: a tip is added for a feature that was never built

- **GIVEN** a new entry anchored to `ownmind_fix_everything`
- **WHEN** the suite runs
- **THEN** it fails, naming the tip and the missing tool

### Scenario: a tool is renamed and the tip is not updated

- **GIVEN** an existing tip anchored to a tool `mcp/index.js` no longer declares
- **WHEN** the suite runs
- **THEN** it fails at the rename, rather than shipping a tip for a tool that has gone

### Scenario: the anchor is a file that has been deleted

- **GIVEN** a tip anchored to `file:hooks/lib/sync-memory-files.js` and that file is removed
- **WHEN** the suite runs
- **THEN** it fails, because the capability behind the claim went with the file

### Scenario: the tool exists but the sentence is wrong

- **GIVEN** a tip claiming PDF export, anchored to `ownmind_get`
- **WHEN** the suite runs
- **THEN** it passes. The anchor proves the tool exists, not that the prose describes it —
  this is a known limit, and wording remains a review problem

## Requirement: every path that asks for a tip supplies one

Wherever OwnMind instructs the AI to show a tip, OwnMind MUST have put a tip in front of it.
The SessionStart context MUST carry one drawn from `shared/tips.js`.

### Scenario: memory is loaded through the SessionStart hook

- **GIVEN** a new conversation in a tool whose template prints a tip after the startup load
- **WHEN** the hook renders its context
- **THEN** that context contains a tip from the list, marked to be relayed verbatim

### Scenario: the tip line is removed from the SessionStart context

- **GIVEN** `hooks/lib/render-session-context.js` stops emitting a tip
- **WHEN** the suite runs
- **THEN** it fails — the startup instruction would otherwise fire with nothing to relay,
  which is the state that produced tips unrelated to OwnMind

## Requirement: the templates relay the tip instead of composing one

Every line in a config template that carries a tip instruction MUST say OwnMind already
supplies a Tip, MUST forbid inventing one, and MUST say to show nothing when none was
supplied. The check is per line.

### Scenario: a future path forgets to supply a tip

- **GIVEN** some new way of loading memory that carries no tip
- **WHEN** the AI reaches the tip instruction
- **THEN** it shows no tip line at all, because the instruction says so — the absence is
  visible rather than filled in

### Scenario: one of two tip sites in a file reverts

- **GIVEN** `configs/AGENTS.md`, which has a tip site in its startup example and another in
  its display rules, and one of them is returned to the old unsourced wording
- **WHEN** the suite runs
- **THEN** it fails on that line, even though the other line still satisfies every check

### Scenario: Claude Code

- **GIVEN** `configs/CLAUDE.md`, which has never carried the tip instruction
- **WHEN** this change ships
- **THEN** it still carries none, and Claude Code adds no tip of its own
