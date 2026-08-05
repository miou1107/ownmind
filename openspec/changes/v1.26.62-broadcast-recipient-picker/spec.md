# v1.26.62 — Spec

## Requirement 1 — Member filtering is a pure function

`client/src/pages/System/broadcast-recipient-filter.js` exports
`filterMembers(users, query, selectedIds)`. It returns the members whose `name` or
`email` contains `query` case-insensitively, excluding anyone whose id is already in
`selectedIds`, preserving the input order. An empty or whitespace-only query matches
everyone not already selected.

The module holds no React and no network code, so it is testable on its own.

### Scenario: typing narrows on either field

- **GIVEN** users `[{id:1,name:'Vin',email:'vincent@fontrip.com'}, {id:4,name:'Joanna',email:'joanna@fontrip.com'}]`
- **WHEN** `filterMembers(users, 'jo', [])` is called
- **THEN** the result is the Joanna row only
- **AND** `filterMembers(users, 'VINCENT@', [])` also returns the Vin row, because the
  match is case-insensitive and covers email

### Scenario: already-selected members drop out of the suggestions

- **GIVEN** the same two users
- **WHEN** `filterMembers(users, '', [4])` is called
- **THEN** the result is the Vin row only

### Scenario: nothing matches

- **GIVEN** the same two users
- **WHEN** `filterMembers(users, 'zzz', [])` is called
- **THEN** the result is an empty array, not null and not undefined

### Scenario: the caller passes something that is not a list

- **GIVEN** `users` is `null`, `undefined`, or a non-array
- **WHEN** `filterMembers` is called
- **THEN** it returns an empty array rather than throwing, because the modal calls it
  during the window before the fetch resolves

## Requirement 2 — End-time conversion is a pure function

`client/src/pages/System/broadcast-ends-at.js` exports two functions.

`defaultEndsAtLocal(now)` returns the `YYYY-MM-DDTHH:mm` string, in the browser's local
zone, for the instant 30 days after `now`. It takes `now` as an argument so the test can
pin it.

`localToIso(local)` converts that format to a full ISO 8601 string with an offset, and
returns `null` for an empty, whitespace-only, or unparseable input, so the caller can use
one falsy check to mean "permanent".

### Scenario: the default is thirty days out, in local time

- **GIVEN** `now` is `new Date('2026-08-05T09:15:00+08:00')`
- **WHEN** `defaultEndsAtLocal(now)` is called
- **THEN** the result matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/` and carries no timezone
  suffix, because `<input type="datetime-local">` rejects a value that does
- **AND** `new Date(result) - now` is exactly 30 days in milliseconds

The assertion is written as a difference rather than a literal string on purpose. A
literal would pin the test to whatever zone the machine running it happens to be in, and
would go red on a runner set to UTC. `new Date(result)` reads the zone-less string as
local, which is the same reading the browser gives the input element, so the difference
holds in every zone.

### Scenario: a zone-less local string becomes a real instant

- **GIVEN** any well-formed local string `s`, for example `'2026-09-04T09:15'`
- **WHEN** `localToIso(s)` is called
- **THEN** the result carries an explicit offset or the `Z` suffix
- **AND** `new Date(localToIso(s)).getTime()` equals `new Date(s).getTime()`, that is, the
  conversion preserved the instant that the browser's own reading of the field denotes

### Scenario: empty means permanent

- **GIVEN** any of `''`, `'   '`, `null`, `undefined`
- **WHEN** `localToIso` is called on it
- **THEN** the result is `null`
- **AND** the same holds for an unparseable string such as `'not a date'`

## Requirement 3 — The dialog picks members by name

`NewBroadcastModal` fetches `GET /api/admin/users` once when it opens. The recipient
field is a text input over a chip list: typing filters, choosing appends a chip, and each
chip has its own remove control. The field carries no user ids anywhere in the interface.

Below the field, one line states the current target: everyone when nothing is chosen, or
the count when something is.

### Scenario: choosing two people

- **GIVEN** the member list has loaded
- **WHEN** the admin types `jo`, picks Joanna, then types `am` and picks Amiee
- **THEN** two chips are shown, each labelled with a name
- **AND** the submitted payload carries `target_users` as the two matching integer ids
- **AND** those ids are the values from `/api/admin/users`, not positions in the list

### Scenario: nobody chosen means everyone

- **GIVEN** the member list has loaded and no chip is present
- **WHEN** the admin submits
- **THEN** the payload has no `target_users` key at all, which is what the server reads
  as "all users"
- **AND** the line under the field says the broadcast goes to everyone

### Scenario: the member list fails to load

- **GIVEN** `GET /api/admin/users` returns an error
- **WHEN** the dialog is open
- **THEN** an inline message under the field says the member list could not be loaded
- **AND** the search input is disabled
- **AND** submitting still works and sends to everyone, because that path needs no member
  list

### Scenario: reopening the dialog starts clean

- **GIVEN** the admin chose two members, closed the dialog without submitting, and
  reopened it
- **WHEN** the dialog renders
- **THEN** no chips are present

## Requirement 4 — The end time defaults to thirty days out

The end-time field is `<input type="datetime-local">`, prefilled on open with
`defaultEndsAtLocal(new Date())`. A hint under it states that clearing the field means
permanent.

### Scenario: the default is submitted

- **GIVEN** the dialog opened and the admin did not touch the end-time field
- **WHEN** the admin submits
- **THEN** the payload's `ends_at` is the ISO 8601 string for thirty days after the
  moment the dialog opened
- **AND** the created broadcast's 生效區間 shows that date rather than 永久

### Scenario: cleared means permanent

- **GIVEN** the admin cleared the end-time field
- **WHEN** the admin submits
- **THEN** the payload has no `ends_at` key
- **AND** the broadcast is permanent, exactly as every broadcast created before this
  release

### Scenario: reopening recomputes the default

- **GIVEN** the dialog was opened, closed, and opened again the next day
- **WHEN** it renders
- **THEN** the prefilled value is thirty days after the second opening, not the first,
  because the initial form state is computed per open rather than held in a module
  constant

## Requirement 5 — The API contract is unchanged

`POST /api/broadcast/admin` receives the same shapes it receives today:
`target_users` as an array of positive integers when present, `ends_at` as an ISO 8601
string when present, both absent otherwise.

`validateBroadcastFormClient` is not modified. Its `target_users_invalid` branch is no
longer reachable from this dialog, because the ids now come from a list of real members
rather than from typed text; the branch stays because the function documents the server's
own rule and its tests pin that.

### Scenario: the server sees no difference

- **GIVEN** a broadcast created through the new dialog with two recipients and an end time
- **WHEN** the request body reaches `validateBroadcastPayload` in `src/routes/broadcast.js`
- **THEN** it passes every check unchanged, and the row written to `broadcast_messages`
  is indistinguishable from one created by the old dialog with the same values typed by
  hand

## Requirement 6 — All three locales carry the new wording

`zh.json` is the source; `en.json` and `ja.json` carry the same key set. Keys that
described ids or ISO formats are replaced, and the placeholder key for the end-time field
is removed, because `<input type="datetime-local">` ignores `placeholder`.

### Scenario: no key is left dangling

- **GIVEN** the modal after this change
- **WHEN** every `t('…')` call in `NewBroadcastModal.jsx` is checked against the
  dictionaries
- **THEN** each key exists in all three files
- **AND** no key removed from `zh.json` is still referenced anywhere under `client/src/`
