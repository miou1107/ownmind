# v1.26.44 — Spec

## Requirement 1 — The served shell's base href always resolves to the mount root

This is the whole requirement. Everything else is a consequence.

**Invariant.** For any dashboard route URL `U` that Express answers with the SPA
shell, the emitted `<base href>` `B` must satisfy:

```
new URL(B, U).href === <absolute URL of the mount root, trailing slash included>
```

Resolved against the request URL, the base must land on the directory that
actually holds `index.html` and `assets/`.

### Scenario: a two-segment route under the reverse-proxy prefix

- **GIVEN** the SPA is mounted at `/dashboard` in Express and nginx exposes it at
  `/ownmind/dashboard`, stripping `/ownmind` before proxying
- **WHEN** a browser hard-loads `https://example.com/ownmind/dashboard/portal/handoffs`
- **THEN** the shell is served with `<base href="../">`
- **AND** the browser resolves the asset reference `./assets/index-*.js` to
  `https://example.com/ownmind/dashboard/assets/index-*.js`, which returns 200
- **AND** `document.baseURI` is `https://example.com/ownmind/dashboard/`, so
  `main.jsx` derives `basename = '/ownmind/dashboard'` and `client.js` derives
  `API_BASE = '/ownmind'`
- **NOTE** `basename` was broken before this change; `API_BASE` was not. Its regex
  tolerates trailing segments, so it yielded `/ownmind` even from the poisoned
  `/ownmind/dashboard/portal/`. This scenario asserts both are correct, not that
  both were repaired

### Scenario: a two-segment route with no proxy prefix

- **GIVEN** the SPA is reached directly at `http://localhost:3100/dashboard`
- **WHEN** a browser hard-loads `http://localhost:3100/dashboard/portal/handoffs`
- **THEN** the shell is served with `<base href="../">`
- **AND** the resolved app root is `http://localhost:3100/dashboard/`

The same emitted value serves both scenarios. This is what keeps the mounting
prefix-agnostic: the value never encodes a prefix, so no prefix can be wrong.

### Scenario: a one-segment route

- **GIVEN** the SPA is mounted at `/dashboard`
- **WHEN** a browser hard-loads `/dashboard/login`
- **THEN** the shell is served with `<base href="./">`, because the directory of
  `/dashboard/login` already is the mount root

### Scenario: a trailing slash adds a level

- **GIVEN** the SPA is mounted at `/dashboard`
- **WHEN** a browser hard-loads `/dashboard/portal/handoffs/`
- **THEN** the shell is served with `<base href="../../">`, because a trailing
  slash makes the requested path itself the document's directory

### Scenario: the mount root is untouched

- **GIVEN** a request for `/dashboard/`
- **WHEN** `express.static` serves `index.html` from disk before the fallback runs
- **THEN** the on-disk `<base href="./">` is already correct and nothing is
  rewritten

## Requirement 2 — Drift in the shell cannot silently disable the fix

The shell is a build artefact generated from `client/index.html`. A rewrite that
depends on matching a literal string would silently no-op if that string changed,
and the failure mode would be the blank page this change exists to remove.

### Scenario: the base tag is present

- **GIVEN** the served HTML contains a `<base href="...">` tag
- **WHEN** the shell is served for a route needing `../`
- **THEN** that tag's `href` is replaced, and exactly one `<base>` tag remains

### Scenario: the base tag has been removed from the shell

- **GIVEN** the served HTML contains no `<base>` tag
- **WHEN** the shell is served for a route needing `../`
- **THEN** a `<base href="../">` tag is inserted as the first thing in `<head>`,
  so asset references still resolve to the mount root
- **AND** the result still contains exactly one `<base>` tag

Inserting into `<head>` rather than before `</head>` matters: the base must
precede the asset references it governs.

## Requirement 3 — Existing behaviour is preserved

### Scenario: asset misses still 404

- **GIVEN** a request for `/dashboard/portal/assets/index-*.js`
- **WHEN** `express.static` misses it and the path contains a `.`
- **THEN** the response is a 404, not the HTML shell

### Scenario: non-GET methods are untouched

- **GIVEN** a `POST /dashboard/portal/handoffs`
- **WHEN** the fallback middleware runs
- **THEN** it delegates to normal error handling and returns no HTML

### Scenario: a missing shell file does not become a 500

- **GIVEN** `src/public/dashboard/index.html` does not exist, as when the client
  has not been built
- **WHEN** a route request reaches the fallback
- **THEN** it delegates to normal error handling, matching the previous
  `res.sendFile` error path

### Scenario: the response is still HTML

- **GIVEN** any route request answered with the shell
- **THEN** the `Content-Type` is `text/html`
