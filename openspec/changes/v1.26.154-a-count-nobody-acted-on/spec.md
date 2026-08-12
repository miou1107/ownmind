# Spec — the reminder names what it counted

## Requirement 1 — the line reports matched over total

### Scenario: the server sent totals

- **GIVEN** an account with 32 team standards, 4 of which match a commit
- **WHEN** the reminder renders
- **THEN** it reads `Team standards 4/32`

### Scenario: a category matched nothing

- **GIVEN** 4 preferences, none matching
- **THEN** it reads `Preferences 0/4`

The zero stays. It is the difference between "looked, found none" and "never asked", which is
the distinction the whole display exists to draw.

### Scenario: the server sent no totals

- **GIVEN** a server between v1.26.151 and this release, or the legacy fallback endpoint
- **THEN** the bare `Team standards 4` is printed and no denominator is invented

A denominator guessed at is a number the caller was never told.

## Requirement 2 — matching memories are named, once an hour

### Scenario: the first operation of its kind this hour

- **GIVEN** no window open for this session and this trigger
- **THEN** the counts line is followed by one row per category that matched, naming each memory
- **AND** the window opens

### Scenario: a later operation of the same kind, inside the hour

- **THEN** the counts line is printed alone, with no names

### Scenario: a different kind of operation, inside the same hour

- **GIVEN** a commit listing was shown at 10:00
- **WHEN** a deploy happens at 10:20
- **THEN** the deploy names are listed

They are different memories. A window that spans both would report one set as already seen on
the strength of the other.

### Scenario: a second session inside the window

- **THEN** that session gets its own listing

The listing exists to put the names into one AI's context. A session that never saw them has
not seen them, whatever another session was shown.

### Scenario: a category matched nothing

- **THEN** it has a count in the line and no name row

### Scenario: the caller prints its own iron-rule banner

- **GIVEN** a `delete` or `install` trigger, where the banner lists the iron rules
- **THEN** the name rows omit `iron_rule`

Only the caller knows whether that banner is about to print, so the decision is made there and
`names` is passed in.

## Requirement 3 — the wording matches what the hook did

The line MUST say the memories were **found**, not loaded. The hook counts and names them; it
does not put their contents into anyone's context. The source text is English and carries the
instruction to relay it translated, with the counts and the version tag copied exactly
(v1.26.152's route, unchanged).

## Requirement 4 — the window key survives an older state file

### Scenario: an entry written before this release

- **GIVEN** a state file keyed by the bare session id
- **WHEN** it is read with a trigger
- **THEN** nothing matches and the next operation lists in full

One extra listing is the safe direction; reading it as a window would suppress one that was
never shown.

## Requirement 5 — the command path knows its session

`hooks/ownmind-iron-rule-check.sh` MUST pass `session_id` from the payload to the renderer. It
had been parsing the payload for `tool_name` and the command and discarding the session id, so
the command path had nothing to key a window by.

## Out of scope

Tagging the untagged team standards. Five have a real trigger and could not be written from
the account this was developed on (404: not the owner, not an admin). Five govern a kind of
work rather than a kind of operation and have no honest trigger to carry.
