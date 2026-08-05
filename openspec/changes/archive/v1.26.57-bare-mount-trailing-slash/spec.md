# v1.26.57 — bare mount path spec

Every scenario is exercised by a test that sends a real request through the app and
resolves the emitted `Location` the way a browser would, against **two** bases. A raw
string comparison would pass for the broken absolute form, which is exactly how this
survived v1.26.48.

---

## Requirement 1 — the bare mount path redirects, and stays inside the prefix

### Scenario: `/dashboard` redirects to its own directory

- **GIVEN** a request for `/dashboard` with no trailing slash
- **THEN** the response is a 301
- **AND** the `Location` is relative — it does not begin with `/`

### Scenario: the same emitted value works with and without the proxy prefix

- **GIVEN** the `Location` emitted for `/dashboard`
- **WHEN** a browser resolves it against `http://x/`
- **THEN** it lands on `http://x/dashboard/`
- **WHEN** the same value is resolved against `http://x/ownmind/`
- **THEN** it lands on `http://x/ownmind/dashboard/`
- **AND** it never lands on `http://x/dashboard/` in the prefixed case, which is the
  production bug: an unrelated site

### Scenario: `/admin` behaves identically while the legacy console is served

- **GIVEN** the manifest still lists signposts, so `/admin` is mounted static
- **WHEN** `/admin` is requested with no trailing slash
- **THEN** the same two-base resolution holds for `/admin/`

### Scenario: the retired branch is unaffected

- **GIVEN** the manifest has no signposts left, so `/admin` is a redirect rather than a
  static mount
- **THEN** `/admin` still redirects to the console, as v1.26.46 specified
- **AND** the bare-path handler does not interfere with it

---

## Requirement 2 — no redirect loop

This is the failure the fix could introduce, and it is worse than the bug: a loop makes
the page unreachable rather than merely wrong.

### Scenario: a path that already has its trailing slash is served, not redirected

- **WHEN** `/dashboard/` is requested
- **THEN** the response is not a redirect
- **AND** the console shell is served

### Scenario: a deeper path is untouched

- **WHEN** `/dashboard/portal/usage` is requested
- **THEN** the response is not a redirect
- **AND** the SPA shell handles it, as it did before

### Scenario: a real file under the mount is still served

- **WHEN** an asset under `/dashboard/assets/…` is requested
- **THEN** it is served by `express.static`, not intercepted

---

## Requirement 3 — the query string survives

serve-static preserves it today (`/ownmind/dashboard?a=1` → `/dashboard/?a=1`), so
dropping it would be a regression introduced by the fix rather than a pre-existing one.

### Scenario: a query on the bare path is carried to the redirect target

- **WHEN** `/dashboard?tab=x&y=1` is requested
- **THEN** the resolved target ends in `/dashboard/?tab=x&y=1`

### Scenario: no query means no stray `?`

- **WHEN** `/dashboard` is requested
- **THEN** the `Location` contains no `?`

---

## Requirement 4 — one rule, not two copies

### Scenario: both mounts use the same helper

- **THEN** `/dashboard` and `/admin` get their bare-path handling from a single exported
  function, so a future third static mount has one obvious thing to call
- **AND** the helper derives its redirect target from the mount path rather than taking
  it as a second argument that could disagree

### Scenario: the helper refuses a mount path it cannot handle

- **GIVEN** a mount path that is not a single absolute segment (empty, `/`, or
  containing a query)
- **THEN** the helper throws at install time rather than installing a handler that
  redirects somewhere unintended

---

## Requirement 5 — the paths that were already correct stay correct

v1.26.48 made these relative. A regression here would be invisible without an assertion,
because the absolute form still works when there is no proxy prefix — which is exactly
how the two static mounts went unnoticed for four days.

### Scenario: `/` still resolves to the console under both bases

### Scenario: `/me` and paths below it still resolve to the console usage page

### Scenario: `/setup` still resolves within the prefix
