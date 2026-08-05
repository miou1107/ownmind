# v1.26.43 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Establish the real shape before changing anything

- [x] Confirm the symptom live: dashboard footer and sidebar read `v1.20.1`,
      server on 1.26.41
- [x] Trace the value: `App.jsx:61` literal → `Layout.jsx` props → `Footer.jsx`
      and `Sidebar.jsx`
- [x] Find the existing version sources and check whether either suits a footer:
      `/api/memory/init` returns the caller's whole compact memory set,
      `/api/usage/admin/clients` is admin-only and computes install coverage.
      Neither does.
- [x] Discover the larger duplication: the `SERVER_VERSION` IIFE is copy-pasted
      into `memory.js`, `nightly-upgrade-reminder.js` and `admin-clients.js`.
      Adding a fourth consumer without consolidating would make it worse.
- [x] Confirm `Footer.jsx` already handles an empty changelog, and that
      `changelog.empty` exists in all three locales, so dropping the mock needs
      no new code

## Phase 1 — Decisions taken to Vin

- [x] Changelog panel: drop the mock, show the existing empty state. A real feed
      needs product decisions about summarising long Chinese entries for three
      locales.
- [x] Scope: version only. The other three placeholders in the same
      `layoutProps` block get their own change.
- [x] Version transport: decided without asking, as a technical call. Runtime over
      the wire, not a build-time constant, because a cached bundle reporting its
      own build version is the same class of failure as the literal being fixed.

## Phase 2 — RED tests

- [x] Create `tests/dashboard-version-source.test.js`
- [x] Shared module matches `package.json` and yields a semver triple
- [x] Drift guards: no local `SERVER_VERSION` declaration under `src/`, and every
      consumer imports the shared module
- [x] Endpoint: 200 with `{ version }`, `version` as the only key, auth applied
      not bypassed, mounted in `app.js`
- [x] Client drift guard: no version literal under `client/src`, `App.jsx` uses
      the hook, `MOCK_CHANGELOG` gone
- [x] Hook: goes through `apiGet`, never a bare `fetch`, starts empty
- [x] Footer empty-state branch and all three locale strings
- [x] Run and confirm RED for the right reason (the new modules do not exist)

## Phase 3 — Implementation

- [x] `src/utils/server-version.js` — the single definition
- [x] `src/routes/version.js` — `createVersionRouter({ auth })`, factory-style to
      match `createDebugRouter` / `createNarrativeRouter` so it is testable
- [x] Replace all three duplicate IIFEs with imports, and drop the now-unused
      `createRequire` import from each (verified it had no other use in any)
- [x] Mount `/api/version` in `src/app.js`
- [x] `client/src/hooks/useServerVersion.js`
- [x] `client/src/App.jsx` — literal and `MOCK_CHANGELOG` removed, hook wired,
      `changelog: []`
- [x] New tests green, client build succeeds. Suite totals are not quoted here: a
      second session is adding tests to this same tree, so any number recorded
      would be wrong within minutes.

## Phase 4 — Verify beyond the unit tests

- [x] Two of my own drift guards were initially over-broad and caught a doc
      comment (`SERVER_VERSION='1.17.0'` in `nightly-upgrade-reminder.js`). The
      test was wrong, not the code; both now strip comments first.
- [x] Mutation-test all six guards, each fails when subverted:
      literal restored in `App.jsx` (1 red), local `SERVER_VERSION` re-added
      (2 red), route unmounted (1 red), placeholder initial state (1 red), raw
      `fetch` bypassing the api client (1 red), auth removed from the route (1 red)
- [x] Client build: succeeds, CSS hash unchanged (`index-obDkY7bq.css`), JS
      changes as expected

## Phase 4b — Code review round

Reviewer returned 1 Critical, 3 Important, 7 Minor. Every finding reproduced
against the actual code before acting.

- [x] **Critical: the feature did not work for anyone logging in during the page
      load.** `useServerVersion` was called from `App`, which mounts once inside
      `BrowserRouter` outside `RequireAuth` and never unmounts, because
      `LoginPage` stores the key and SPA-navigates without a reload. The `[]`-dep
      effect therefore fired once on the cold visit with no key, took a 401, and
      never retried: the footer would have stayed empty for the entire session.
      Confirmed by reading `main.jsx` and `LoginPage.jsx`. Moved the hook into
      `Layout`, which renders only beneath `RequireAuth`, and added a module-scope
      cache so the per-navigation remount does not refetch.
- [x] **Important: the same cause emitted a spurious 401 on every login-page
      load**, polluting the `auth_failed` channel built to identify genuinely
      misconfigured clients, and racing `clearApiKey()` against a freshly stored
      key. The Layout move removes the request from `/login` entirely.
- [x] **Important: "21 releases" was false in five places, two of them permanent
      source comments.** Actual count between v1.20.1 and v1.26.41 is 42 tags.
      Replaced with "from v1.20.1 onward" in code comments, which is precise and
      cannot go stale, and with the measured 42 in the prose.
- [x] **Important: the change was attributed to v1.26.42** in `App.jsx` and two
      test messages — that is the other session's number. Corrected, and the new
      `App.jsx` comments rewritten in English per the project i18n rule.
- [x] Minor: `stripComments` could destroy a file. Its regex treated the `/*`
      inside the glob `'src/**'` in `src/utils/templates.js` as a comment opener
      and ate 112 of 167 lines, losing three of four `patterns:` keys. Replaced
      with a single-pass scanner that tracks string state; string contents are
      preserved because one guard looks for a string literal. Re-measured:
      167 → 153 lines, all four keys intact.
- [x] Minor: `sourceFiles` walked `src/public/dashboard/assets/`, the gitignored
      vite bundle, so the guards scanned a different file set depending on whether
      the client had been built locally. Added `public` to the skip list and
      switched to `withFileTypes` so a broken symlink cannot throw mid-walk.
- [x] Minor: the client literal regex was narrower than the spec claimed. Widened
      to case-insensitive (covers `APP_VERSION`, `appVersion`) and to allow a JSX
      brace, and the spec now states plainly that concatenation is not covered and
      why.
- [x] Minor: spec Scenario 1.4 had no test. Extracted `readPackageVersion` as a
      seam and covered throw / missing / empty / present.
- [x] Minor: two hook assertions read unstripped source, so a commented-out call
      could have satisfied them. All three now strip first.
- [x] Minor: `client/package.json` is a fifth place a version lives (`1.21.0`).
      Nothing reads it, so it is recorded rather than changed.
- [x] Minor: the "identical IIFE" claim was not literally true (`memory.js` had a
      one-line `catch`, `admin-clients.js` a different relative path). Now
      "near-identical", with the difference stated.

## Phase 4c — Re-verification after the review fixes

- [x] 20 tests green (15 → 20), full suite green
- [x] Mutation battery extended to 8, all caught: literal restored in `App.jsx`
      (1 red), local `SERVER_VERSION` re-added (2), route unmounted (1),
      placeholder initial state (1), raw `fetch` instead of `apiGet` (1), auth
      removed from the route (1), **hook moved back into `App` — the reviewer's
      Critical (3)**, failure written to the cache (1)
- [x] The failure-cached mutation first reported "not caught". Investigated rather
      than accepting it: the `perl` substitution had silently not applied. Re-ran
      with an explicit check that the file changed, and it does go red. A mutation
      test has to verify the mutation happened.
- [x] Confirmed `stripComments` no longer truncates `templates.js`
- [x] Client build succeeds

## Phase 4d — Not verified, and stated as such

- [ ] **No React render test.** `client/` has no testing-library and no jsdom, so
      "the value actually reaches the footer" rests on structural assertions
      (Layout is the only caller, every `<Layout>` is inside `RequireAuth`,
      `LoginPage` does not render `Layout`) plus a manual incognito login check
      after deploy. That is what let the Critical through the first time: every
      client assertion confirmed the literal was *absent*, none that a value
      *arrives*.

## Phase 5 — Docs and version

- [ ] `openspec/changes/v1.26.43-dashboard-version-source/` — proposal, spec, tasks
- [ ] `CHANGELOG.md`, `FILELIST.md`
- [ ] `README.md` × 3 — version line
- [ ] Bump `package.json`

## Phase 6 — Quality gates (mandatory)

- [ ] `superpowers:verification-before-completion`
- [ ] `superpowers:requesting-code-review`
- [ ] `superpowers:receiving-code-review`

## Phase 7 — Release

- [ ] Commit, no Co-Authored-By, author Vin
- [ ] Tag, deploy, migrations as a deploy step (no schema change expected)
- [ ] Browser check: the footer shows the real version, and the changelog panel
      shows its empty state rather than stale entries

## Phase 8 — Concurrency note

- [x] A second session is working in **this same working tree** on the SPA
      deep-link fix and claimed `v1.26.42` at 07:43. This change takes
      `v1.26.43` and commits with explicit pathspecs so the other session's
      in-progress `openspec/changes/v1.26.42-spa-deep-link-base/` is not swept
      into this commit. Whichever lands second owns reconciling `package.json`,
      `CHANGELOG.md` and `FILELIST.md`.

## Phase 9 — Filed, not done here

- [ ] `profile: { name: 'User' }` in `App.jsx` — the dashboard greets every user
      as "User"
- [ ] `onLogout: () => console.log('logout')` — the logout control does nothing
- [ ] `useState('super_admin')` — every user's role starts as super_admin, so the
      admin and super-admin nav sections show for everyone. Not a privilege hole
      while those routes are placeholders and the server authorises per request,
      but misleading, and it becomes one when a real page lands there.
- [ ] A real changelog feed for the footer panel
- [ ] `client/package.json` declares `"version": "1.21.0"`, a fifth place a version
      lives. Nothing reads it, so it is cosmetic, but it is out of step.
- [ ] No React render harness in `client/`. Adding one would have caught this
      release's Critical directly instead of via review.
