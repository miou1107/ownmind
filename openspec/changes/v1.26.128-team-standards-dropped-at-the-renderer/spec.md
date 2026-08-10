# v1.26.128 — Spec

## Requirement: team standards reach the AI on the hook path

When `/api/memory/init` returns `team_standards_digest`, the SessionStart context MUST
include it.

### Scenario: a member of a team with standards starts a conversation

- **GIVEN** the init response carries a digest of two standards
- **WHEN** the hook renders its context
- **THEN** both titles appear under a team-standards heading

### Scenario: the digest is titles only

- **GIVEN** the rendered team-standards section
- **WHEN** the AI needs the text of one standard
- **THEN** the section names `standard_detail` as the way to read it in full

### Scenario: a user with no team standards

- **GIVEN** an init response with no digest
- **WHEN** the hook renders its context
- **THEN** no team-standards heading appears at all

### Scenario: an iron rule and a team standard disagree

- **GIVEN** both are present in the context
- **WHEN** the AI reads them
- **THEN** the iron rules appear first, so precedence is carried by order rather than by a
  claim about precedence

### Scenario: the renderer stops reading the digest

- **GIVEN** the team-standards block is removed from `render-session-context.js`
- **WHEN** the suite runs
- **THEN** it fails — the previous state was silent, and an AI that ignores rules it never
  received is indistinguishable from an AI that ignores rules
