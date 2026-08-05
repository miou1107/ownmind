# v1.26.43 — Spec: dashboard version source

> Companion to `proposal.md`. Observable behaviour in GIVEN / WHEN / THEN form.

---

## Requirement 1 — The server SHALL define its version exactly once

`package.json` is the only place a version lives on the server side.

### Scenario 1.1 — the shared module agrees with the manifest

- **GIVEN** `src/utils/server-version.js`
- **WHEN** `SERVER_VERSION` is read
- **THEN** it equals `package.json`'s `version`
- **AND** it matches a semver triple, never an empty string

### Scenario 1.2 — no other definition survives

- **GIVEN** every `.js` file under `src/`, comments stripped
- **WHEN** each is scanned for a local `SERVER_VERSION` declaration
- **THEN** only `src/utils/server-version.js` declares one
- **AND** comments are stripped because `nightly-upgrade-reminder.js` documents
  its threshold with the example `SERVER_VERSION='1.17.0'`, which is prose

### Scenario 1.3 — consumers import rather than restate

- **GIVEN** any file under `src/` that references `SERVER_VERSION`
- **WHEN** its imports are inspected
- **THEN** it imports from `utils/server-version.js`

### Scenario 1.4 — an unreadable manifest does not stop the server

- **GIVEN** a `requireFn` that throws, or returns a manifest with no `version` or
  an empty one
- **WHEN** `readPackageVersion` is called with it
- **THEN** the result is `'0.0.0'` and no exception escapes
- **AND** the function is exported as a seam precisely so this branch is reachable
  from a test rather than only reasoned about
- **BECAUSE** a server that cannot read its own manifest should still serve
  memories, and every consumer treats `0.0.0` as older than anything, so the
  upgrade reminder over-advertises rather than silently suppressing

---

## Requirement 2 — `GET /api/version` SHALL return the version and nothing else

### Scenario 2.1 — the happy path

- **GIVEN** an authenticated request to `/api/version`
- **WHEN** it is served
- **THEN** the status is 200 and the body is `{ version }` matching `package.json`

### Scenario 2.2 — no incidental disclosure

- **GIVEN** the response body
- **WHEN** its keys are enumerated
- **THEN** `version` is the only one
- **BECAUSE** a footer needs one string; anything else is an information leak with
  no consumer

### Scenario 2.3 — auth is applied, not bypassed

- **GIVEN** a router constructed with an auth middleware that rejects
- **WHEN** `/api/version` is requested
- **THEN** the rejection stands and the handler does not run

### Scenario 2.4 — the route is reachable

- **GIVEN** `src/app.js`
- **WHEN** its mounts are read
- **THEN** `/api/version` is mounted

---

## Requirement 3 — The dashboard SHALL NOT carry a version of its own

This is the defect being fixed and MUST NOT come back.

### Scenario 3.1 — no version literal assigned in the client

- **GIVEN** every `.js` and `.jsx` file under `client/src`, comments stripped
- **WHEN** each is scanned for a version-ish identifier assigned a string literal,
  case-insensitively and allowing a JSX brace
- **THEN** none is found
- **AND** comments are stripped so a historical reference such as "v1.20.1 步驟 3"
  in a comment does not fail the check
- **BUT NOT** every conceivable spelling: a version assembled by concatenation or
  from a template expression would pass. This guards the shape that actually
  broke rather than claiming to be exhaustive, because a check that tried to catch
  every spelling would fire on unrelated numbers and get muted

### Scenario 3.1b — comment stripping SHALL respect string literals

- **GIVEN** a source file containing a glob such as `'src/**'`
- **WHEN** comments are stripped
- **THEN** the file is not truncated at that point
- **BECAUSE** a naive `/\/\*[\s\S]*?\*\//` treats the `/*` inside that string as a
  comment opener. Measured on `src/utils/templates.js`: 167 lines reduced to 55
  and three of four `patterns:` keys lost, which would hide any declaration placed
  after it

### Scenario 3.1c — the scan SHALL cover the same files on every machine

- **GIVEN** a checkout where the client has been built, leaving the gitignored
  `src/public/dashboard/assets/index-*.js` bundle on disk
- **WHEN** source files are enumerated
- **THEN** that directory is skipped, so the guard does not depend on local state

### Scenario 3.2 — the hook is called only where a key already exists

This is the requirement the first implementation failed, and it is what makes the
feature work at all rather than merely removing the literal.

- **GIVEN** the dashboard component tree
- **WHEN** callers of `useServerVersion` are enumerated
- **THEN** `client/src/components/common/Layout.jsx` is the only one
- **AND** `App.jsx` neither calls it nor passes a `version` prop down
- **AND** every `<Layout>` in `App.jsx` sits inside `RequireAuth`
- **AND** `LoginPage` does not render `Layout`
- **BECAUSE** `App` mounts once inside `BrowserRouter`, outside the auth gate, and
  never unmounts across an SPA login. A `[]`-dep effect there fires only on the
  cold visit, before any key exists, takes a 401, and never retries — leaving the
  footer empty for the whole session and emitting a spurious `auth_failed` log
  line on every login-page load

### Scenario 3.5 — a failure SHALL NOT be cached

- **GIVEN** a request that returns a non-ok response
- **WHEN** the result is handled
- **THEN** the module-scope cache is left untouched, so a later mount retries
- **AND** only successful values are cached, which is what makes the per-navigation
  remount cheap without making a transient failure permanent

### Scenario 3.3 — the hook goes through the shared api client

- **GIVEN** `client/src/hooks/useServerVersion.js`
- **WHEN** its source is read
- **THEN** it calls `apiGet('/api/version')` and does not call `fetch` directly
- **BECAUSE** `apiGet` applies the `/ownmind` prefix detection that a bare `fetch`
  would miss under the nginx reverse proxy, and routes 401 into the
  `auth-expired` event

### Scenario 3.4 — nothing is shown rather than something wrong

- **GIVEN** the hook's initial state
- **WHEN** the request is in flight, or has failed
- **THEN** the rendered version is empty
- **AND** the initial state is not a placeholder version, which is what produced
  the original bug

---

## Requirement 4 — Dropping the mock changelog SHALL leave a working panel

### Scenario 4.1 — the mock is gone

- **GIVEN** `client/src/App.jsx`
- **WHEN** its source is read
- **THEN** `MOCK_CHANGELOG` is absent

### Scenario 4.2 — the empty state already exists

- **GIVEN** `Footer.jsx` receives an empty changelog array
- **WHEN** the panel is opened
- **THEN** it branches on `changelog.length === 0` and renders `changelog.empty`
- **AND** that string is defined in `zh.json`, `en.json` and `ja.json`
