# v1.26.77 — Spec

## Requirement 1 — The self-check authenticates the way the server authenticates

### Scenario: asking the server whether the data arrived

- **GIVEN** a machine with valid credentials
- **THEN** the request carries `Authorization: Bearer <key>`

`src/middleware/auth.js` reads `req.headers.authorization` and requires the `Bearer `
prefix. It reads no other header. Anything else is a 401, every time.

### Scenario: the middleware changes

- **GIVEN** the header or scheme the middleware parses is edited
- **THEN** a test goes red

Asserted by reading `src/middleware/auth.js` from the test, not by describing it. The two
sides of this contract were faked independently and neither could see the disagreement.

## Requirement 2 — A 404 and a 401 are different answers

### Scenario: a server too old to have the endpoint

- **THEN** the report says the server needs v1.26.72 or newer

Unchanged, and worth stating because it is what hid this defect: the router returns 404
before auth runs, so the single real-world check performed when this feature was written
never reached the code that was broken.

### Scenario: a server that has the endpoint and rejects the credential

- **THEN** the report gives the status it got

The check exits 0 either way: not being able to ask is not the same as knowing the answer
is bad, and an upgrade must not fail on it.
