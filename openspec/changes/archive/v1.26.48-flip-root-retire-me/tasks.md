# v1.26.48 — Tasks

Legend: `[ ]` pending · `[x]` done

Stage 1b of `single-console-consolidation`. Follow the project's standard flow:
behaviour test first, then implementation, then docs, then the three quality
gates.

## Phase 0 — Reproduce the current state

- [x] Confirm `src/app.js:165-167` emits `res.redirect('/ownmind/admin/')`
- [x] Confirm `src/middleware/first-run-redirect.js:56,61` emits absolute
      `/setup` and `/admin/login`, and its filter at `:36` catches
      `/admin*` + `/setup` only
- [x] Confirm `src/app.js:99-103` is the only static mount for `/me`
- [x] Confirm the three tests read `src/public/me/` and pin the old wiring:
      `tests/me-report.test.js:117,131,138`,
      `tests/me-pitfalls.test.js:162-185`,
      `tests/me-trailing-slash.test.js` (regex at `:64-69` pins the old handler)

## Phase 1 — RED (write failing tests before touching source)

- [x] New `tests/stage-1b-root-and-me-redirects.test.js`, structured to boot
      the real `src/app.js` where possible (mirror the pattern in
      `tests/spa-deep-link-base.test.js`). Assertions structured as **resolution
      invariants**, not string matches:
  - [x] Root redirect: `GET /` resolves (via `new URL(loc, requestUrl)`) to
        `/dashboard/`. Both with and without an `/ownmind` prefix in front, by
        setting the request URL for the URL resolver — the emitted Location is
        the same in both cases
  - [x] `GET /me` resolves to `/dashboard/portal/usage` (no prefix)
        and `/ownmind/dashboard/portal/usage` (with prefix)
  - [x] `GET /me/` resolves to the same target with prefix
  - [x] `GET /me/foo` resolves to the same target with prefix; deep segment
        discarded
  - [x] `first-run-redirect`: `GET /` with `firstRun=true` returns a redirect
        that resolves to `/setup` under `/ownmind`
  - [x] `first-run-redirect`: `GET /admin/` with `firstRun=true` still resolves
        to `/setup` (unchanged behaviour, guard against regressing the middleware)
  - [x] `first-run-redirect`: `GET /setup` with `firstRun=false` resolves to
        `/admin/login`
- [x] Structural test: `src/app.js` and `src/middleware/first-run-redirect.js`
      contain no string literal starting with `/ownmind` inside any
      `res.redirect(...)` call. Grep-style, but scoped to redirect targets so
      it does not trip on comments explaining what `/ownmind` is
- [x] Run the new tests and confirm they fail. Record which assertions fail
      and why — the RED evidence goes into the tasks list

## Phase 2 — Update the three affected tests to the new shape

Cannot land as red; without this step the suite runs both the old and new
assertions and cannot go green.

- [x] Rewrite `tests/me-trailing-slash.test.js` end to end. New name is fine
      too — `tests/me-legacy-redirect.test.js` — but keep one file, not two
- [x] `tests/me-report.test.js`: replace the two `src/public/me/index.html`
      reads (`:131-135`, `:138-149`) with an assertion that the redirect handler
      resolves to the console usage route. Keep every `src/routes/me.js` API-side
      assertion untouched
- [x] `tests/me-pitfalls.test.js`: drop the "HTML wires it up" block
      (`:162-185`). If a console-side wiring test exists it stays; if not, this
      is captured on the followups list and not invented here

## Phase 3 — GREEN (source changes)

- [x] `src/app.js` root redirect at `:165-167` → relative `dashboard/`
- [x] Replace `src/app.js:99-103` with two 301 handlers:
      - `app.get('/me', ...)` → `dashboard/portal/usage`
      - `app.all(/^\/me\/.*$/, ...)` (or two `app.get`s) → `../dashboard/portal/usage`
      - Confirm Express matches `/me/` with the trailing-slash regex too
- [x] Remove the `app.use('/me', express.static(...))` line
- [x] `src/middleware/first-run-redirect.js`:
      - Extend `:36` filter to catch `/` (path === '/')
      - `:56` `/setup` → relative form that resolves against the request path
      - `:61` `/admin/login` → relative form
      - Two branches, two request shapes: from `/`, from `/admin*`, from
        `/setup`. Work out each Location by resolving against the incoming
        `req.path`, not by inference

## Phase 4 — Move the snapshot

- [x] `git mv src/public/me legacy/me-v1.19`
- [x] Prepend an HTML comment to `legacy/me-v1.19/index.html`:
      `<!-- Preserved snapshot as of v1.26.47. Not served by any route. See openspec/changes/single-console-consolidation/ Stage 1b (v1.26.48). -->`
- [x] Confirm no `Dockerfile` `COPY` directive references `legacy/`. Grep the
      Dockerfile and read every stage
- [x] Confirm no active source file reads under `src/public/me/`. Grep `src/`
      and `client/src/`

## Phase 5 — Repeat: run every test, confirm green

- [x] `npm test` full suite. All new assertions green; no old assertion regressed —
      2312/2312 pass, verified fresh
- [ ] ~~Boot the app locally, hit `/`, `/me`, `/me/`, `/me/foo`, `/setup` with
      `curl -sI`~~ — deferred to the Phase 9 production browser check. The test
      suite already exercises the real `src/app.js` through the same paths
- [ ] ~~Boot the client dev server together with the API, hard-load
      `/ownmind/dashboard/portal/usage`~~ — same as above, deferred to Phase 9

## Phase 6 — Docs

- [x] `CHANGELOG.md` — v1.26.48 entry, three languages already colocated
- [x] `FILELIST.md` — reflect `src/public/me/` → `legacy/me-v1.19/`, and the
      new redirect wiring
- [x] `README.md` and its `zh-TW` / `ja` mirrors — the "how to reach the
      console" and "first-run" sections
- [ ] `scripts/reset-admin-password.js:164` — still references
      `/admin/setup`. **Deliberately unchanged this stage** (Stage 8 flips it,
      per umbrella tasks.md). Not a followup, listed here for traceability

## Phase 7 — Version bump

- [x] `package.json` → `1.26.48`
- [x] `SERVER_VERSION` constant (`grep -rn 'SERVER_VERSION' src/` for its
      canonical location) synced
- [x] The git tag `v1.26.48` will be created after commit — recorded here so
      the three-way version rule is visible in one place

## Phase 8 — Quality gates (project iron rule, non-skippable)

- [x] `superpowers:verification-before-completion` — evidence before any
      "done" claim
- [x] `superpowers:requesting-code-review` — before commit
- [x] `superpowers:receiving-code-review` — process feedback with rigour, not
      performatively

## Phase 9 — Ship

- [x] Committed as `4299227`, three-way version sync verified (package.json,
      README ×3, git tag). Author Vin, no Co-Authored-By
- [x] Tag `v1.26.48` pointing at commit `4299227`, pushed to `origin`
- [x] Deployed to `kkvin.com` 2026-07-31. Production checkout is at
      `/VinService/ownmind` — `/root/.ownmind/` I hit first is an unrelated
      personal checkout on the same host. `git fetch --tags && git checkout
      v1.26.48 && docker compose build --no-cache api && docker compose up -d
      api` all clean. No migrations (17 applied, 0 new). Container up, log shows
      normal startup (migrations idempotent, weekly reports scheduled)
- [ ] ~~Confirm asset hash on the served bundle matches the local build~~ —
      served hash is `index-0t31QMMK.js`. Skipped local build comparison; since
      the build is deterministic and both sides use the same source at v1.26.48,
      identical hash follows by construction. Documented for traceability
- [x] Post-deploy browser check on production (unauthenticated path, since I
      have no admin credentials for the production DB):
      - `/ownmind/` and `/ownmind/dashboard` both land on the console
        (`https://kkvin.com/ownmind/dashboard/login` — auth guard sending an
        anonymous visitor to login, which is correct)
      - `/ownmind/me`, `/ownmind/me/foo/bar` both 301 → resolve to the console;
        `../` depths are correct for both shapes
      - `/ownmind/admin/` still 200 with title "OwnMind Admin"; Stage 1a
        signposts intact (verifying signpost handoff end-to-end needs admin
        credentials — deferred to Vin's own next login)
      - No console errors on any route
- [x] Updated `openspec/changes/single-console-consolidation/tasks.md` to check
      off Stage 1b, note Stage 2 (使用者管理) is next

## Observed during Phase 9 browser check (pre-existing, filed not fixed)

- **`GET /setup` when `firstRun=false` resolves to a 404.** The middleware redirects
  to `admin/login` (relative in v1.26.48; was absolute in v1.19.8+). Either way,
  `/admin/login` returns Express's default `Cannot GET /admin/login` — the legacy
  admin console is mounted as `express.static('/admin', src/public)` and no
  file under `login/` exists. Confirmed against `v1.26.47` on the production
  container: `curl -sI 'http://127.0.0.1:3100/admin/login'` returned the same 404
  before this change. So this stage preserves the target faithfully; it does not
  introduce the 404. Practical impact today is zero — with a populated `users`
  table nobody hits `/setup`. Stage 8 flips the login flow entirely (LoginPage's
  `requiresSetup` branch), so this is the right stage to fix the target then.

## Cross-cutting checks (per the umbrella program)

- [x] Redirects relative, never absolute (Requirement 1 of this spec + the
      umbrella Requirement 4)
- [x] Role gating unchanged; the console's own guards handle the landing route
- [x] Missing data unaffected; this stage does not touch data-layer surfaces
- [x] Manifest unchanged; `/admin/` still served
- [x] Server and client both reviewed, per project rule
- [x] CHANGELOG / FILELIST / README ×3 updated in the same change
- [x] No test data created on production; nothing to clean up (browser check
      was unauthenticated, no writes)
