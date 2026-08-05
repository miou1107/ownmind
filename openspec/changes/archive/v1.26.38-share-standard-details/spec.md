# v1.26.38 — Spec: shared read visibility for team-standard details

> Companion to `proposal.md`. This file pins the observable behaviour in
> GIVEN / WHEN / THEN form.

---

## Requirement 1 — Detail fragments of a shared standard SHALL be readable by every member

A `standard_detail` row MUST be readable by any authenticated caller when its
parent `team_standard` row is active, regardless of which account uploaded it.

### Scenario 1.1 — non-uploader reads a fragment by type

- **GIVEN** an active `team_standard` summary owned by user A
- **AND** a `standard_detail` row owned by user A whose `metadata.parent_id`
  points at that summary
- **WHEN** user B calls `GET /api/memory/type/standard_detail`
- **THEN** the response includes user A's fragment

### Scenario 1.2 — non-uploader finds a fragment through search

- **GIVEN** the same fragment, containing the word `smart-stage`
- **WHEN** user B calls `GET /api/memory/search?q=smart-stage`
- **THEN** the fragment appears in the results

### Scenario 1.3 — non-uploader opens a fragment by id

- **GIVEN** the same fragment with id `N`
- **WHEN** user B calls `GET /api/memory/N`
- **THEN** the server responds 200 with the fragment instead of 404

---

## Requirement 2 — Fragments under a retired or opted-out summary SHALL stay hidden

Visibility MUST follow the parent. A fragment whose parent is not an active,
subscribed `team_standard` for the caller MUST NOT be returned.

### Scenario 2.1 — parent disabled, fragment becomes invisible

- **GIVEN** a `team_standard` summary whose `status` is `disabled`
- **AND** an active `standard_detail` row pointing at it
- **WHEN** user B reads by type, by search, or by id
- **THEN** the fragment is not returned

### Scenario 2.2 — caller opted out of the parent standard

- **GIVEN** an active `team_standard` summary with id `P`
- **AND** user B has an active `profile` row tagged `team_standard_optout`
  whose `metadata.team_standard_id` is `P`
- **WHEN** user B reads fragments
- **THEN** no fragment whose parent is `P` is returned

### Scenario 2.4 — a disabled shared row is not readable by id

- **GIVEN** a `standard_detail` row whose own `status` is `disabled`, under an
  active parent
- **WHEN** a caller who does not own it requests `GET /api/memory/<id>`
- **THEN** the server responds 404, because by-id reads must not be the gap
  that lets retired content back out

### Scenario 2.3 — the uploader still sees their own fragments

- **GIVEN** the disabled-parent fragment from scenario 2.1, owned by user A
- **WHEN** user A reads by type, by search, or by id
- **THEN** the fragment is returned, because ownership alone grants read access

---

## Requirement 3 — Private memory types SHALL remain owner-only

Sharing MUST widen only `team_standard` and `standard_detail`. Every other type
MUST keep its current owner-scoped behaviour.

### Scenario 3.1 — another member's private memory stays invisible

- **GIVEN** an active `iron_rule` (or `project`, `profile`, `env`) owned by user A
- **WHEN** user B reads by type, by search, or by id
- **THEN** the memory is not returned

---

## Requirement 4a — Creating or editing a shared type SHALL require admin

Because a `standard_detail` row now reaches every member's assistant as
authoritative team-standard text, minting or editing one MUST require the same
admin role its summary already requires.

### Scenario 4a.1 — non-admin cannot mint a fragment

- **GIVEN** an authenticated caller whose role is below admin
- **WHEN** they `POST /api/memory` with `type` of `standard_detail`
- **THEN** the server responds 403 and no row is created

### Scenario 4a.2 — the gate covers every shared type

- **GIVEN** the create, update, and disable handlers
- **WHEN** their role checks are inspected
- **THEN** each tests `isSharedMemoryType(...)` rather than comparing against
  `team_standard` alone

---

## Requirement 4 — Write access SHALL NOT widen

Read sharing MUST NOT grant write access. Update and disable MUST continue to
match on the caller's own `user_id`.

### Scenario 4.1 — member cannot edit another member's fragment

- **GIVEN** a `standard_detail` row owned by user A that user B can now read
- **WHEN** user B calls `PUT /api/memory/<id>`
- **THEN** the server responds 404 and the row is unchanged

### Scenario 4.2 — member cannot disable another member's fragment

- **GIVEN** the same row
- **WHEN** user B calls the disable endpoint for that id
- **THEN** the server responds 404 and the row stays active

---

## Requirement 5 — Malformed parent references SHALL fail closed

A fragment whose `metadata.parent_id` is missing or non-numeric MUST simply not
match, and MUST NOT abort the surrounding query with a cast error.

### Scenario 5.1 — non-numeric parent id

- **GIVEN** a `standard_detail` row whose `metadata.parent_id` is `"abc"`
- **WHEN** any caller other than the owner reads fragments
- **THEN** the query succeeds and the row is absent from the results

### Scenario 5.2 — absent parent id

- **GIVEN** a `standard_detail` row with no `parent_id` key in `metadata`
- **WHEN** any caller other than the owner reads fragments
- **THEN** the query succeeds and the row is absent from the results

---

## Requirement 6 — Session start SHALL NOT load fragments

`/init` MUST keep excluding rows tagged `rule_detail`, so the two-layer lazy
design is preserved.

### Scenario 6.1 — init payload stays summary-only

- **GIVEN** an active summary with 36 active fragments
- **WHEN** any member calls `/init`
- **THEN** the response carries the summary and none of the 36 fragments

---

## Requirement 7 — The documented retrieval tool SHALL accept the type

The `ownmind_get` MCP tool MUST offer `standard_detail` in its type enum, and
its banner MUST render a human-readable label for it.

### Scenario 7.1 — tool schema accepts the type

- **GIVEN** the `ownmind_get` tool definition
- **WHEN** its `type` enum is inspected
- **THEN** it contains `standard_detail`

### Scenario 7.2 — banner names the type

- **GIVEN** a successful `ownmind_get('standard_detail')` call
- **WHEN** the version banner is rendered
- **THEN** it names the type instead of falling back to the generic
  `Memory loaded` label that `resolveType` supplies for unmapped types

### Scenario 7.4 — the fetch can be narrowed to one standard

- **GIVEN** several summaries each holding fragments
- **WHEN** a caller requests `GET /api/memory/type/standard_detail?parent_id=P`
- **THEN** only fragments whose parent is `P` are returned
- **AND** omitting `parent_id` returns every readable fragment rather than a
  silently truncated subset

### Scenario 7.3 — save still refuses the type

- **GIVEN** the `ownmind_save` tool definition
- **WHEN** its `type` enum is inspected
- **THEN** it does NOT contain `standard_detail`, because fragments are created
  only through `ownmind_upload_standard`
