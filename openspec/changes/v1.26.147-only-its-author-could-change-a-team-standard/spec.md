# v1.26.147 — Spec delta: an admin SHALL be able to change a team standard whoever uploaded it

## ADDED Requirement: shared-type writes SHALL resolve on ownership OR admin rank

Every write route on `/api/memory/:id` SHALL decide access through one resolution: the row is
writable by its owner, and — when its type is `team_standard` or `standard_detail` — by a
caller of rank `admin` or above. Any other caller SHALL receive the same 404 as a row that
does not exist.

### Scenario: an admin edits a standard another account uploaded

- **GIVEN** memory 108 is a `team_standard` owned by user 4
- **AND** the caller is a `super_admin` (user 1)
- **WHEN** the caller `PUT`s memory 108
- **THEN** the update is applied to user 4's row
- **AND** the response is 200 with the updated memory

### Scenario: an admin edits a standard_detail fragment

- **GIVEN** the row is a `standard_detail` owned by another account
- **WHEN** an admin writes to it
- **THEN** the write is applied

### Scenario: an admin tries to edit a private memory of another account

- **GIVEN** memory 100 is an `iron_rule` owned by user 4
- **WHEN** a `super_admin` writes to it
- **THEN** the response is 404 Memory not found
- **AND** the response is byte-identical to the response for an id that does not exist

### Scenario: an ordinary member tries to edit a standard they can read

- **GIVEN** the caller has role `user` and is not the owner
- **AND** the standard is readable by them under the shared read predicate
- **WHEN** they write to it
- **THEN** the response is 404
- **AND** being able to read it grants nothing

### Scenario: the owner is matched whatever type their id arrives as

- **GIVEN** the row's `user_id` is read back as a string and `req.user.id` is a number
- **WHEN** the owner writes to their own row
- **THEN** they are recognised as the owner
- **AND** the write is not recorded as an admin write

## MODIFIED Requirement: the admin-only gate on shared types SHALL apply to every write verb

The gate that refuses a non-admin writing to a shared type SHALL run on update, disable,
enable and revert. Previously it ran on update and disable only, and could be reached only by
the row's owner.

### Scenario: a non-admin owner edits their own team standard

- **GIVEN** the caller owns the `team_standard` and has role `user`
- **WHEN** they update, disable, enable or revert it
- **THEN** the response is 403 with the admin-only message
- **AND** the row is unchanged

### Scenario: a member re-enables a standard an admin retired

- **GIVEN** a `team_standard` was disabled by an admin
- **AND** the caller is its owner with role `user`
- **WHEN** they call enable
- **THEN** the response is 403
- **AND** the standard stays retired

### Scenario: reverting is treated as editing

- **GIVEN** a `team_standard` with history versions
- **WHEN** a non-admin owner reverts it to an earlier version
- **THEN** the response is 403

## ADDED Requirement: an admin write SHALL be recorded as one

When a write is authorized by admin rank rather than ownership, the `memory_history` row for
that write SHALL carry `admin_write` naming the action, the acting user and the owning user.

### Scenario: an admin updates someone else's standard

- **WHEN** the update is written
- **THEN** the history entry's metadata contains
  `admin_write: { action: 'update', by_user_id, owner_user_id }`
- **AND** the existing `update_reason`, `tier_change` and `title_change` fields are unaffected

### Scenario: an admin disables, enables or reverts someone else's standard

- **THEN** the history entry carries the same field with the matching action

### Scenario: an owner writes to their own memory

- **THEN** no `admin_write` field is added
- **AND** the history entry has the shape it had before this change

## ADDED Requirement: the write SHALL be scoped to the row's owner, not the caller

The authorized `UPDATE` SHALL bind the resolved row's `user_id`.

### Scenario: an admin write reaches the row

- **GIVEN** access has been resolved for a row owned by another account
- **WHEN** the UPDATE runs
- **THEN** it matches that row
- **AND** it does not re-apply the caller's own user_id, which would write nothing and return
  no row while reporting success

## ADDED Requirement: history SHALL open to whoever may write

### Scenario: an admin lists the history of another account's standard

- **WHEN** they call `GET /api/memory/:id/history`
- **THEN** the versions are returned, so the revert they are permitted to make is choosable

### Scenario: a member lists the history of another account's standard

- **THEN** the response is 404, as before

## Unchanged

- Read visibility (`memory-visibility.js`) is untouched: members read team standards and
  their fragments exactly as they did.
- Private types (`iron_rule`, `project`, `env`, `profile`, `coding_standard`) stay
  owner-only on every route.
- `POST /` still refuses a non-admin creating a shared type.
- No production data is rewritten by this change.
