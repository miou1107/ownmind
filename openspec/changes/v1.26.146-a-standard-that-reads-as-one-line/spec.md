# v1.26.146 — Spec delta: reading a team standard SHALL return its text, whichever shape it is stored in

## ADDED Requirement: a fragment-shaped standard SHALL answer a read with its fragments

`GET /api/memory/:id` SHALL, when the row is a `team_standard` with `standard_detail` rows
keyed to it, return those fragments in the response alongside the row.

### Scenario: reading a standard whose text lives in fragments

- **GIVEN** memory 152 is a `team_standard` whose `content` is upload boilerplate
- **AND** six `standard_detail` rows carry `metadata.parent_id = 152`
- **WHEN** a caller reads memory 152 by id
- **THEN** the response carries all six fragments, each with its title, content and level
- **AND** the caller can act on the standard without knowing how it was stored

### Scenario: reading a standard whose text is on its own record

- **GIVEN** memory 869 is a `team_standard` with no rows keyed to it
- **WHEN** a caller reads memory 869 by id
- **THEN** the response is what it was before this change
- **AND** no empty `fragments` array is added to it

### Scenario: reading a memory that is not a team standard

- **GIVEN** the row is an `iron_rule`, `project`, `env` or any other type
- **WHEN** a caller reads it by id
- **THEN** no fragment lookup is performed
- **AND** the response is unchanged

### Scenario: a fragment with a heading but no body

- **GIVEN** a fragment stores an empty `content` (a heading with no text under it)
- **WHEN** the standard is read
- **THEN** that fragment is still present in the response with its title and level
- **AND** it is not dropped for being empty

## ADDED Requirement: the merge SHALL apply only where one standard was asked for

### Scenario: listing every team standard

- **WHEN** a caller reads `type = 'team_standard'` without an id
- **THEN** no fragments are attached to any row
- **AND** the response size is what it was before this change

### Scenario: searching

- **WHEN** a caller searches and a fragment-shaped standard matches
- **THEN** the result row is the same 400-character preview as before
- **AND** the caller reaches the full text by reading that row's id

### Scenario: loading memory at session start

- **WHEN** the session-start context is rendered
- **THEN** it carries standard titles as before
- **AND** no fragment text is added to it

## ADDED Requirement: a truncated merge SHALL say so

### Scenario: a standard within the character budget

- **GIVEN** a standard's fragments total fewer characters than the budget
- **WHEN** it is read
- **THEN** every fragment is returned
- **AND** `fragments_returned` equals `fragments_total`
- **AND** `fragments_truncated` is false

### Scenario: a standard past the character budget

- **GIVEN** a standard's fragments exceed the budget
- **WHEN** it is read
- **THEN** fragments are returned up to the budget
- **AND** `fragments_total` reports how many exist
- **AND** `fragments_truncated` is true, so the caller can tell the answer is partial

### Scenario: a single fragment larger than the whole budget

- **WHEN** the first fragment alone exceeds the budget
- **THEN** that fragment is still returned rather than an empty list
- **AND** `fragments_truncated` is true

## ADDED Requirement: the merge SHALL respect the sharing rules that already govern fragments

### Scenario: a member reading a standard uploaded by someone else

- **GIVEN** `standard_detail` rows are shared across users (v1.26.38)
- **WHEN** a member who does not own the fragments reads the standard
- **THEN** the fragments are returned to them
- **AND** the same readable predicate that governs the type-listing path is applied

### Scenario: a retired standard

- **GIVEN** a fragment's status is not active
- **WHEN** the standard is read
- **THEN** that fragment is not returned

## MODIFIED Requirement: the documented read SHALL no longer describe two shapes

Supersedes the `ownmind_get` description's clause distinguishing standards whose text is on
their own record from standards split into fragments. After this change the distinction has no
consequence for a reader, and stating it invites the reader to act on it.

### Scenario: an assistant reading the tool description

- **WHEN** an assistant reads the `ownmind_get` description
- **THEN** it is told that reading a standard by id returns its full text
- **AND** it is not asked to work out which of two shapes it is holding

## ADDED Requirement: a truncated read SHALL name a follow-up that returns the document

### Scenario: reaching the rest of a truncated standard

- **GIVEN** a read was truncated at the budget
- **WHEN** the caller makes the follow-up call the response named
- **THEN** it receives the standard's fragments in document order
- **AND** not in the order they were last written, which after a re-sync is the reverse

## ADDED Requirement: editing a standard SHALL NOT be able to swallow its fragments

The consumer here is `ownmind_update`, not a console: `client/src` has no memory editor and
never issues `PUT /api/memory/:id`. It is the sharper case, because `ownmind_get` already
instructs an assistant to read a memory in full before updating it so as not to overwrite the
rest — an instruction that, against a merged `content`, would mean "write every fragment back
into the parent".

### Scenario: an assistant reads a fragment-shaped standard and saves it unchanged

- **GIVEN** the read returned the standard with its fragments
- **WHEN** the assistant calls `ownmind_update` on that memory without changing anything
- **THEN** the parent row's `content` is unchanged
- **AND** every fragment still exists and is still keyed to that parent
- **AND** the `fragments` field is not written back into any column

## ADDED Requirement: a sync SHALL record where each section sits in the document

### Scenario: a standard uploaded before ordinals existed

- **GIVEN** every fragment of a standard is unchanged and none carries a position
- **WHEN** the standard is synced
- **THEN** each fragment gains its position
- **AND** its content hash is not rewritten

### Scenario: a section moves

- **WHEN** two sections swap places with no text change
- **THEN** both positions are rewritten
- **AND** neither is treated as an edit

### Scenario: a heading is renamed

- **WHEN** a chunk arrives under a title no existing fragment has
- **THEN** the old fragment is disabled and a new one is inserted
- **AND** the new one takes the position the document gives it, not the order it was created
