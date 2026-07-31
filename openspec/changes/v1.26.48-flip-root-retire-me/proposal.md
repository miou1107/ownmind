# v1.26.48 — Flip the entry point and retire `/me/`

Stage 1b of `single-console-consolidation`. Prerequisite: v1.26.46 / v1.26.47
finished Stage 1a — every feature that only lived in the legacy `/me/` UI has a
seat inside the console at `/dashboard/`, and every legacy `/admin/` tab has an
amber signpost that hands the session across.

Stage 1a was safe to ship because nothing about where users land had changed.
This stage changes exactly that.

## What changes for the user

`/` and `/ownmind/` stop redirecting to the legacy `/admin/`. They redirect to
the console at `/dashboard/`. Every `/me` and `/me/*` URL 301s to the console's
usage page. Nothing that a logged-in user used yesterday goes away — the new
target is the console, which already carries every feature `/me/` used to.

Three consoles become two.

## Why now, why one stage

The umbrella program (`openspec/changes/single-console-consolidation/`) was
explicitly split so this flip could ship on its own. Stage 1a shipped the
consequence of Stage 1b (the amber signposts) **before** the cause (the root
flip). Reversing the order would have left users on a console with placeholders
where their tools used to be. Now the seats exist, so the door can move.

`/admin/` is not touched. It still serves the legacy console until the manifest
in `shared/legacy-console-manifest.js` empties, per Stage 1a's Requirement 5.

## Root cause of the two absolute paths

Two files still write absolute Locations that embed the public prefix:

1. `src/app.js:165-167` — `res.redirect('/ownmind/admin/')` was hardcoded when
   this repo only ever ran under `/ownmind`. It is the same class of defect the
   iron rule "SPA 動態偵測安裝路徑必須跟 `<base href>` tag 配套" and v1.26.44's
   base-href fix each addressed at a different layer: **Express cannot know the
   public prefix, because nginx strips it before proxying.** A hardcoded
   `/ownmind` is a bet on a deployment topology this repo already refused to
   make everywhere else.
2. `src/middleware/first-run-redirect.js:56,61` — `res.redirect(302, '/setup')`
   and `res.redirect(302, '/admin/login')` were written under the same
   assumption. Empirically they work today because kkvin.com proxies bare
   `/setup` and `/admin/login` too, but the day someone runs this behind a
   proxy that strips a prefix without a matching bare mount, both break, and no
   test would fail.

## Chosen approach

- Root `/` redirects to `'dashboard/'` (relative). Under the `/ownmind` prefix
  the browser resolves this to `/ownmind/dashboard/`; without a prefix, to
  `/dashboard/`. Same emitted value serves both, by construction.
- `/me` → `'dashboard/portal/usage'` (relative).
- `/me/` and `/me/*` → `'../dashboard/portal/usage'` (relative). Two routes,
  not one, because Express's Location is resolved against the request URL and
  the trailing-slash case sits one directory deeper. Same terminal URL, two
  different `../` counts. The existing `/me` handler at `src/app.js:99-102`
  already lives with this constraint and documents it.
- `first-run-redirect` also intercepts `/`, so a fresh install landing on the
  root reaches the wizard. Without this, once `/` no longer points at
  `/admin/`, the middleware's admin-path filter (`:36`) never fires on the root
  request, and a fresh install goes straight to a console the user has no
  credentials for.
- `first-run-redirect`'s two absolute Locations are made relative for the same
  reason as the root redirect.

## Legacy snapshot moves out of `src/`

`Dockerfile:18` is a whole-directory `COPY src/ ./src/`. Leaving
`src/public/me/` in place would keep shipping a dead UI in the runtime image,
and Requirement 5 of the umbrella spec is that retired sources must not be
served. The snapshot moves to `legacy/me-v1.19/` at the repo root with a header
comment stating what it is and why it is preserved. `legacy/` is not copied by
any Dockerfile stage; verified before this proposal was written.

## What breaks in the test suite

Three tests read `src/public/me/index.html` or assert the exact source-code
shape of the old `/me` handler:

- `tests/me-report.test.js:117,131,138` — asserts the static mount exists and
  the file exists. Rewritten to assert the redirect exists and lands on the
  console.
- `tests/me-pitfalls.test.js:162-185` — reads the HTML to verify the pitfalls
  section calls `/api/me/pitfalls`. The API endpoint is unchanged and still
  covered by the rest of the file; the "the HTML wires it up" assertion moves
  to the console at `client/src/pages/Portal/PitfallsPage.jsx`, where it belongs.
- `tests/me-trailing-slash.test.js` — the whole file asserts the conditional
  trailing-slash handler that this change removes. Replaced by the new
  redirect tests.

## Non-goals

- No change to `/admin/`. It still serves until the manifest empties.
- No change to `/dashboard/` behaviour, routing, or auth.
- No change to any API endpoint. `/api/me/*` stays; only the static UI moves.
- The `LoginPage.jsx` change that adds a `requiresSetup` branch is Stage 8,
  not this stage. Until Stage 8, a sole-admin recovery still goes through
  `/admin/setup`, which still routes because `/admin/` is still served.

## Known limitation

`src/public/dashboard/` is gitignored. Today `/` redirects to a checked-in
file that always renders. After this change the root depends on a build
artefact. The umbrella program's "Known gap" section already flags this and
notes that a full decision is deferred until Stage 8. For this stage the
existing convention holds: `npm start` on a fresh clone expects the client to
be built (or served in dev separately), and the deploy image builds the client
before serving.

## Filed, not fixed here

- The api client still has no request timeout (surfaced by the Stage 0
  review). Cross-cutting, deferred as noted in the umbrella tasks.
- The two Vin-blocking questions from Stage 1a (narrative role gating, and the
  team_blindspot vs "real zero" tension) are unchanged by this stage.
