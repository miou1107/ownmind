# v1.26.136 — Spec delta: id validation on the memory routes

## ADDED Requirement: a path parameter that is not an id SHALL answer 404

Any request to a memory route whose `:id` is not a bare run of digits within the range of
the `INT` column it is compared against SHALL be answered with 404 and the body
`{"error":"Memory not found"}`. It SHALL NOT reach a database query, and SHALL NOT be
reported as a server error.

### Scenario: a path that is a word, not an id

- **WHEN** `GET /api/memory/stats` is requested
- **THEN** the response is 404
- **AND** no database query is issued
- **AND** nothing is logged as a server error

### Scenario: a number with something attached to it

- **WHEN** `GET /api/memory/12abc` is requested
- **THEN** the response is 404
- **AND** memory 12 is not returned

### Scenario: an id beyond the column's range

- **WHEN** `GET /api/memory/2147483648` is requested
- **THEN** the response is 404 rather than a server error

### Scenario: a well-formed id still behaves exactly as before

- **WHEN** `GET /api/memory/1` is requested by its owner
- **THEN** the memory is returned with 200
- **AND WHEN** `GET /api/memory/999999` is requested
- **THEN** the response is 404, as it already was

## ADDED Requirement: the check SHALL be wired once for the whole router

The validation SHALL run as router-level parameter handling, not as a line repeated in each
handler, so that a route added later inherits it without anyone remembering to add it.

### Scenario: every existing id route is covered

- **WHEN** any of `GET /:id`, `PUT /:id`, `PUT /:id/disable`, `PUT /:id/enable`,
  `PUT /:id/revert`, `GET /:id/history` is called with a non-id
- **THEN** each answers 404
