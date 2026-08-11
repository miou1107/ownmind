# v1.26.141 — Spec delta: the session context SHALL say when to look, not only what is known

## ADDED Requirement: an unrecognised internal term SHALL prompt a search

The context delivered at session start SHALL instruct the assistant to search memory when a
company-specific term it does not recognise appears, before answering or starting work.

### Scenario: the user's wording matches a title

- **GIVEN** memory holds a standard titled 「發布網頁到 pages.fontrip.com」
- **WHEN** the user says 「發 pages」
- **THEN** the standard is looked up before any work begins

### Scenario: the user's wording does not match any title

- **WHEN** the user says 「公司 pages」, which matches no title word-for-word
- **THEN** the term is still searched
- **AND** the assistant does not improvise a method

### Scenario: an ordinary sentence with nothing unfamiliar in it

- **WHEN** nothing in the message is an unrecognised internal term
- **THEN** no search is required
- **AND** the instruction does not ask for one on every message

## ADDED Requirement: claiming to have no information SHALL require having looked

### Scenario: something of the user's that is in memory

- **GIVEN** the access details for a server are stored as a project memory
- **AND** project memories are not listed in the session context
- **WHEN** the user asks about that server
- **THEN** memory is searched for it
- **AND** the assistant does not state that it has no information about it

### Scenario: something of the user's that is genuinely absent

- **WHEN** the search returns nothing
- **THEN** the assistant may say so
- **AND** what it says is now a statement it has evidence for

## MODIFIED Requirement: a standard SHALL be readable from its title

Supersedes `ownmind_get("standard_detail")` as the documented way to read a listed standard.
Measured 2026-08-11: that call returns `{"data": []}` for a standard whose text is held on
its own record, which is the case for the standards written most recently.

### Scenario: reading a standard the assistant has only seen listed

- **WHEN** the assistant needs the full text of a listed standard
- **THEN** the instruction it is given resolves the title to a row and then reads that row
- **AND** it is not sent to a call that returns an empty list

### Scenario: an account with no team standards

- **THEN** no standards block is rendered
- **AND** the standing instruction to search is still present — the account still has memories

## ADDED Requirement: the guidance SHALL reach every tool, not only Claude Code

Claude Code loads memory through the SessionStart hook. The operations manual is NOT a
delivery path: it rides on `instructions`, which the init route sends only when `compact` is
false, and every caller in the repo — `ownmind_init` included — asks for compact.

### Scenario: a tool that does not use the SessionStart hook

- **WHEN** that tool is deciding whether to search
- **THEN** the guidance is in front of it in the `ownmind_search` tool description
- **AND** in the config template its install wrote to disk
- **AND** neither of those is stripped by `compact=true`

### Scenario: a rule placed only where compact strips it

- **THEN** that does not count as delivered
- **AND** a test that reads the source file cannot tell the difference, so it is not evidence
