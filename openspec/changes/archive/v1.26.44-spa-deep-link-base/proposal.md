# v1.26.44 — Make dashboard deep links survive a hard load

## Background

Found during the v1.26.41 post-deploy browser check on 2026-07-30, recorded in
`openspec/changes/v1.26.41-dependency-security/tasks.md` Phase 12b, and confirmed
pre-existing: `git diff v1.26.40..v1.26.41` touched neither file involved.

A hard load of a dashboard route renders a completely blank page. No console
error, because the JavaScript bundle never loads at all.

Measured on production:

```
/ownmind/dashboard/portal/assets/index-iF1ipOZR.js   404
/ownmind/dashboard/assets/index-iF1ipOZR.js          200
```

## Root cause

Three things combine:

1. `src/app.js` serves the SPA shell for any GET under `/dashboard` that
   `express.static` misses and that carries no file extension.
2. `client/vite.config.js` sets `base: './'`, so the built shell references its
   assets as `./assets/index-*.js`.
3. `client/index.html` carries `<base href="./">`.

A relative `<base href>` is resolved against the document's own address. On
`/ownmind/dashboard/portal/handoffs` the document's directory is
`/ownmind/dashboard/portal/`, so `./` resolves there, and `./assets/index-*.js`
requests `/ownmind/dashboard/portal/assets/index-*.js`, which does not exist.

The severity is wider than "sub-routes". Every real page in
`client/src/App.jsx` is two segments deep (`/portal/usage`,
`/preference/profile`, `/admin/team`, `/super/config`), so **every page except
`/login` breaks on a hard load**. One-segment routes survive by arithmetic
accident: the directory of `/ownmind/dashboard/login` already *is* the app root.
That is why the v1.20.1 fix behind the iron rule "SPA 動態偵測安裝路徑必須跟
`<base href>` tag 配套" tested clean at the time; the only deep route then was
`/dashboard/login`.

The same miscomputation also poisons `basename` in `client/src/main.jsx`, which
derives from `document.baseURI`. It is invisible today only because the bundle
never executes.

## The design tension

Both `base: './'` (v1.20.0, `cd43c41`) and `<base href="./">` (v1.20.1,
`f4e1fc1`) were deliberate. The app must mount under either `/dashboard` or
`/ownmind/dashboard` without hardcoding a prefix, because nginx strips
`/ownmind` before proxying: **Express never sees the public prefix.** The
relative base is what makes prefix-agnostic mounting work, and it is also what
breaks deep links. Any fix has to keep the first property.

## Options considered

| Option | Verdict |
|---|---|
| Express injects an **absolute** `<base href>` from the mount prefix | Rejected. Express cannot know the public prefix; nginx strips it. It would need `X-Forwarded-Prefix`, i.e. a server-side nginx change outside this repo, and would silently regress to a wrong absolute path if the header were missing. |
| Emit an absolute base at build time from an env var | Rejected. Directly destroys prefix-agnostic mounting: `/dashboard` and `/ownmind/dashboard` would need separate builds. |
| Serve the shell only at the dashboard root, redirect the rest | Rejected. A redirect to the root discards the requested route, so a bookmark or a shared link still fails to land on its page. Preserving it would mean moving to hash routing, a much larger change. |
| **Express computes a relative `../`-walking base from the request path** | **Chosen.** |

## Chosen approach

When Express serves the shell, it rewrites the `<base href>` to the number of
`../` steps that climb from the requested route back to the mount root.

Express has exactly the information required. Inside the middleware mounted at
`/dashboard`, `req.path` is the route *relative to the mount*, with both the
nginx prefix and the mount segment already stripped. Verified empirically:

| Request | `req.path` in the fallback | base href |
|---|---|---|
| `/dashboard/` | never reaches it (static serves `index.html`) | `./` on disk |
| `/dashboard` | never reaches it (static 301s to `/dashboard/`) | n/a |
| `/dashboard/login` | `/login` | `./` |
| `/dashboard/portal/handoffs` | `/portal/handoffs` | `../` |
| `/dashboard/portal/handoffs/` | `/portal/handoffs/` | `../../` |

The emitted value stays **purely relative**, so no absolute prefix is ever
computed or assumed and prefix-agnostic mounting is preserved by construction,
not by configuration.

It fixes the assets and `basename`, and keeps `API_BASE` correct. All three derive
from `document.baseURI`, but only the first two were actually broken: the regex in
`client/src/api/client.js:29` is `^(.*)\/dashboard(\/.*)?$`, which tolerates
trailing segments, so the poisoned `/ownmind/dashboard/portal/` already yielded
`/ownmind`. Measured before and after: both `/ownmind`. An earlier draft of this
proposal claimed all three were broken; review caught it.

## Non-goals

- No change to `client/vite.config.js` or `client/index.html`. `./` remains the
  correct on-disk default: it is what the root request needs, and it keeps the
  shell working when opened directly.
- No change to routing, to the asset 404 behaviour, or to the old `/admin` and
  `/me` UIs.

## Known limitation

The injection lives in Express. If the shell is ever served by a static file
host with its own SPA fallback, that host must do the same rewrite. Recorded in
`tasks.md`.

## Filed, not fixed here

`GET /ownmind/dashboard` (no trailing slash) 301s to `/dashboard/`, dropping the
`/ownmind` prefix, because `serve-static` builds that redirect from the path
Express sees. On kkvin.com the bare `/dashboard/` is also proxied, so it lands on
a working page and no user-visible break exists today. `src/app.js` already
solves this shape for `/me` with a relative `301 → 'me/'`. Kept out of this
change to hold the diff to one defect.
