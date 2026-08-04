# v1.26.57 — the bare mount path redirects off the reverse-proxy prefix

## Why

Found 2026-08-04 during the v1.26.56 post-deploy browser check.

`https://kkvin.com/ownmind/dashboard` — the console URL without a trailing slash —
answers `301 Location: /dashboard/`. That is an absolute path, so the browser drops the
`/ownmind` prefix and lands on `https://kkvin.com/dashboard/`, an **unrelated page**
titled "Vin WorkSpace" that has nothing to do with OwnMind. `/ownmind/admin` does the
same thing, to `https://kkvin.com/admin/`.

Measured on production:

| Request | Status | `Location` | Correct? |
|---|---|---|---|
| `/ownmind/dashboard` | 301 | `/dashboard/` | ✗ leaves the prefix |
| `/ownmind/admin` | 301 | `/admin/` | ✗ leaves the prefix |
| `/ownmind/setup` | 302 | `admin/login` | ✓ relative |
| `/ownmind/me` | 301 | `dashboard/portal/usage` | ✓ relative |

## Cause

Neither bad redirect is written by this codebase. Both come from `express.static`'s
built-in `redirect: true`: when the request resolves to the served directory itself,
serve-static emits `Location = req.originalUrl.pathname + '/'`. nginx has already
rewritten `^/ownmind/(.*)` → `/$1` (`/etc/nginx/sites-enabled/kkvin.com:54-55`), so
Express sees `/dashboard` and writes `/dashboard/` — correct from inside the app,
wrong for the browser, which still holds the prefix.

Two mounts are affected, and they are the only two `express.static` calls in the repo:

- `src/app.js:82` — `app.use('/dashboard', express.static(…))`
- `src/middleware/legacy-admin-mount.js:39` — `app.use('/admin', express.static(publicDir))`

v1.26.48 converted every redirect **the app writes itself** to a relative Location via
`relativeRedirectTarget()`. It could not reach these two, because the redirect is
emitted inside serve-static rather than by our code. Same defect class as v1.26.44 and
v1.26.48, one layer down.

Confirmed identical when curling the container directly on `127.0.0.1:3100`, so this is
the application, not nginx.

## Scope of the breakage

Only the exact bare path. `/ownmind/dashboard/` is 200 and correct, and deep links like
`/ownmind/dashboard/portal/usage` go through the SPA fallback and never reach the
directory redirect. So the failure is confined to someone typing, bookmarking or linking
the console without the trailing slash — which is the natural way to write it.

Not introduced by v1.26.56: `src/app.js` last changed in v1.26.48 and the stats release
touched no routing.

## Approach

A shared `redirectBareMountPath(app, mountPath)` installed immediately **before** each
static mount, so serve-static never gets the chance to emit its absolute Location. It
reuses `relativeRedirectTarget()` — the same helper, so there is one rule about
prefix-safe redirects rather than two.

Two details that are easy to get wrong and are therefore pinned by tests:

- **It must match the bare path only.** `app.get('/dashboard', …)` would also match
  `/dashboard/` under Express's default non-strict routing, and redirecting `/dashboard/`
  to the relative `dashboard/` resolves to `/dashboard/dashboard/` — an infinite loop
  that is worse than the bug being fixed. The handler compares `req.originalUrl`'s
  pathname against the mount path and calls `next()` on anything else.
- **The query string has to survive.** serve-static preserves it today
  (`/ownmind/dashboard?a=1` → `/dashboard/?a=1`), so dropping it would be a regression
  introduced by the fix.

## Out of scope

`{ redirect: false }` on the static mounts is deliberately **not** used on its own. It
would stop the bad Location, but `/dashboard` would then fall through to the SPA shell
handler, which serves `index.html` with a `<base href>` computed for the wrong depth —
the v1.26.44 blank-page failure. The explicit handler is required either way, and it
runs first, so serve-static never sees the bare path.
