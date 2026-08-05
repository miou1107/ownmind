# v1.26.48 — Spec

## Requirement 1 — Every redirect Location in this stage is relative

**Invariant.** No handler this change touches emits a Location that starts with
`/`. Every Location is prefix-agnostic by construction, so the same emitted
value serves both a deployment behind an `/ownmind` reverse proxy and a plain
`/` deployment.

The invariant is asserted structurally against the source (no `/ownmind` string
literal in `src/app.js` or `src/middleware/first-run-redirect.js` redirect
targets) **and** behaviourally (the resolved absolute URL lands on the intended
target).

### Scenario: root under the reverse-proxy prefix

- **GIVEN** the app is proxied at `/ownmind`
- **WHEN** a browser requests `https://example.com/ownmind/`
- **THEN** the response is a redirect with Location `dashboard/`
- **AND** the browser resolves it to `https://example.com/ownmind/dashboard/`

### Scenario: root with no proxy prefix

- **GIVEN** the app is reached directly at `http://localhost:3100`
- **WHEN** a browser requests `http://localhost:3100/`
- **THEN** the same emitted `dashboard/` resolves to
  `http://localhost:3100/dashboard/`

## Requirement 2 — `/me` and `/me/*` land on the console usage page

Every URL under the retired `/me/` surface 301s to `dashboard/portal/usage` on
the console. The emitted Location is chosen so that browser resolution against
the request URL yields the same terminal URL for both the no-trailing-slash and
trailing-slash cases.

### Scenario: `/me` without trailing slash

- **GIVEN** a user has an authenticated session for the console
- **WHEN** they navigate to `/ownmind/me`
- **THEN** the response is 301 with Location `dashboard/portal/usage`
- **AND** the browser resolves it to `/ownmind/dashboard/portal/usage`
- **AND** the console loads without a second login

### Scenario: `/me/` with trailing slash

- **WHEN** the browser hits `/ownmind/me/`
- **THEN** the response is 301 with Location `../dashboard/portal/usage`
- **AND** the browser resolves it to `/ownmind/dashboard/portal/usage`

### Scenario: `/me/anything` deep path

- **WHEN** the browser hits `/ownmind/me/foo` or `/ownmind/me/foo/bar`
- **THEN** the response is 301 with Location `../dashboard/portal/usage`
- **AND** the browser resolves it to `/ownmind/dashboard/portal/usage`
- **AND** the deep segment is discarded, because the retired `/me/` UI kept no
  state in the URL — measured on the source before this change

## Requirement 3 — The first-run wizard is still reachable from the root

**Invariant.** After the root redirect flips, a fresh install (users table
empty) hitting `/` still lands on `/setup`, not on a console the user has no
credentials for.

### Scenario: fresh install visits the root

- **GIVEN** the users table is empty (`firstRun === true`)
- **WHEN** a browser requests `/ownmind/`
- **THEN** the response is a redirect with a Location that the browser resolves
  to `/ownmind/setup`
- **AND** the setup route serves `src/public/setup.html`

### Scenario: post-setup visit to `/setup`

- **GIVEN** the users table has an admin (`firstRun === false`)
- **WHEN** a browser requests `/ownmind/setup`
- **THEN** the response is a redirect that the browser resolves to
  `/ownmind/admin/login` while `/admin/` is still served (i.e. until the
  Stage 1a manifest empties in Stage 7)

### Scenario: fresh install visits the old admin path

- **GIVEN** `firstRun === true`
- **WHEN** a browser requests `/ownmind/admin/`
- **THEN** the response is a redirect that the browser resolves to
  `/ownmind/setup`

## Requirement 4 — Retired sources are not shipped

`src/public/me/` is moved to `legacy/me-v1.19/`. The move is asserted two ways:

- The runtime image built from the current `Dockerfile` does not contain
  `legacy/`. Enforced by construction: no `COPY` directive references it.
- No test file, no `README`, no active production route reads a file under
  `src/public/me/`.

The `legacy/me-v1.19/` directory carries a header comment (as an HTML comment at
the top of `index.html`) stating that the file is a preserved snapshot as of
v1.26.47 and is not served by any route.

## Requirement 5 — Existing tests that codify the old wiring are updated, not
deleted

Three test files are affected. Each has a documented reason it lived, so each
gets rewritten rather than removed:

- `tests/me-trailing-slash.test.js` — asserted the conditional
  `/me` → `me/` handler. Rewritten to assert the new 301 to
  `dashboard/portal/usage`, with both trailing-slash and no-trailing-slash
  cases.
- `tests/me-report.test.js` — its "static page must be served" and "HTML file
  must exist" assertions become "redirect handler exists and resolves to the
  console usage route". The API-side assertions (`/api/me/*` still mounted,
  authenticates, etc.) are unchanged.
- `tests/me-pitfalls.test.js` — its "HTML wires up `/api/me/pitfalls`"
  assertion moves to the console pitfalls page. The API-side assertions are
  unchanged.

None of the three tests may reference `src/public/me/` after this change.
