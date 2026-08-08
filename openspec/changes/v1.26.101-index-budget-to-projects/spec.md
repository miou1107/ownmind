# Spec — the index budget goes where it is the only channel

Module: `hooks/lib/sync-memory-files.js`

## Exported constants

| Name | Value | Meaning |
| --- | --- | --- |
| `IRON_RULE_INDEX_CAP` | 20 | Most index lines an `iron_rule` may take. Their contents already reach the session through the SessionStart hook. |

## Behaviour

### Requirement: a type that reaches the session another way takes a small share

#### Scenario: many iron rules and many projects
- **GIVEN** 143 `iron_rule` and 130 `project` memories
- **WHEN** the index is built
- **THEN** at most `IRON_RULE_INDEX_CAP` iron rules are listed
- **AND** more than 100 projects are listed
- **AND** the total is still within `MEMORY_INDEX_MAX_LINES`

#### Scenario: fewer iron rules than the cap
- **GIVEN** 5 `iron_rule` memories
- **WHEN** the index is built
- **THEN** all 5 are listed
- **AND** no omission note is emitted for them

### Requirement: a capped type still reports everything it left out

#### Scenario: the omission count is the real remainder
- **GIVEN** 143 `iron_rule` memories and a cap of 20
- **WHEN** the index is built
- **THEN** the omission note states 123 more, not the number past some other boundary

The count is derived from the full list rather than from the allocation, so
capping and budget pressure produce one honest number between them.

## Non-goals

- No change to the 140-line or 200-character ceilings, the newest-first
  ordering, the by-need redistribution, or the failure-marker reservation.
- No cap on `project` or `feedback`. Neither has a second route into the session.
