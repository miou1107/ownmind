# v1.26.44 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Reproduce before theorising

- [x] Confirm the reported measurement on production:
      `/ownmind/dashboard/portal/assets/index-*.js` → 404,
      `/ownmind/dashboard/assets/index-*.js` → 200
- [x] Confirm the deep route really is answered with the shell, and that the shell
      it returns still says `<base href="./">` and `./assets/...`
- [x] Confirm `/ownmind/dashboard/login` returns 200, i.e. the break is not
      "all deep routes" but "routes deeper than one segment"
- [x] Read `client/index.html`, `client/vite.config.js`, `client/src/main.jsx`,
      `client/src/api/client.js`, and the `git log` for `cd43c41` / `f4e1fc1` to
      establish that the relative base is deliberate, not a typo
- [x] Re-read the iron rule on pairing SPA install-path detection with a
      `<base href>` tag — this is the same class of issue, one level deeper

## Phase 1 — Measure the true blast radius

- [x] Enumerate the routes in `client/src/App.jsx`: every real page is two
      segments deep (`/portal/*`, `/preference/*`, `/admin/*`, `/super/*`)
- [x] Conclude that **every page except `/login` breaks on a hard load**, which is
      wider than the "sub-route" framing in the report
- [x] Work out why the v1.20.1 fix looked correct at the time: one-segment routes
      survive by arithmetic accident, and `/dashboard/login` was the only deep
      route then
- [x] Note the second victim: `basename` in `main.jsx` derives from
      `document.baseURI` and is equally poisoned, invisible only because the
      bundle never executes

## Phase 2 — Establish what Express actually knows

- [x] Probe `req.path` / `req.baseUrl` for every URL shape, rather than assuming:

      | request | reaches | `req.path` |
      |---|---|---|
      | `/dashboard/` | static (serves index.html) | n/a |
      | `/dashboard` | static (301 → `/dashboard/`) | n/a |
      | `/dashboard/login` | fallback | `/login` |
      | `/dashboard/portal/handoffs` | fallback | `/portal/handoffs` |
      | `/dashboard/portal/handoffs/` | fallback | `/portal/handoffs/` |

- [x] Confirm the decisive constraint: nginx strips `/ownmind` before proxying, so
      Express cannot compute an absolute base. This is what rules out the
      "inject an absolute base href" option
- [x] Confirm `req.path` is already free of both the proxy prefix and the mount
      segment, which is exactly what a relative `../` walk needs

## Phase 3 — RED

- [x] Establish that tests can boot the real `src/app.js` (set `ENCRYPTION_KEY`
      first, as `tests/bootstrap-routes.test.js` does) rather than a hand-built
      mirror of the mounts
- [x] Write `tests/spa-deep-link-base.test.js` against the real app
- [x] Encode the requirement as a resolution invariant, not as a string match:
      resolve the emitted base against the request URL and assert it lands on the
      mount root
- [x] End-to-end assertion: extract every asset reference from the served shell,
      resolve it the way a browser would, and fetch it
- [x] Prefix-agnostic assertion: the emitted base must be neither an absolute path
      nor an absolute URL, and the same value must resolve correctly under both
      `/dashboard` and `/ownmind/dashboard`
- [x] Drift guards: `src/app.js` goes through the helper, the old raw `sendFile`
      is gone, the built shell still has a base tag, and the built shell still
      references assets relatively
- [x] Preserved behaviour: asset miss 404s, non-GET falls through, a missing shell
      file falls through instead of 500ing, response is `text/html`
- [x] Watch it fail. First run: module not found. Second run, after the pure
      helpers existed but before wiring: 19 pass / 6 fail, and the failure reads
      `./assets/index-*.js resolved to /dashboard/portal/assets/index-*.js and
      returned 404` — the production bug, reproduced in a test

## Phase 4 — GREEN

- [x] Add `src/utils/spa-shell.js`: `relativeBaseHref`, `withBaseHref`,
      `createSpaShellHandler`
- [x] Replace the raw `res.sendFile` block in `src/app.js` with the handler
- [x] `withBaseHref` inserts a base tag when none is found instead of silently
      no-opping, because the shell is a build artefact and the no-op failure mode
      is the blank page this change removes
- [x] 25/25 green

## Phase 5 — Verify beyond the unit level

- [x] Build a real prefix-stripping proxy (what nginx does) and confirm every
      route resolves to `/ownmind/dashboard/` with every asset at 200:
      `/portal/handoffs` → `../`, `/preference/vault` → `../`,
      `/login` → `./`, `/portal/handoffs/` → `../../`, `/` → `./`
- [x] Real browser check over CDP, before and after, on the same page:

      | | `document.baseURI` | `#root` children | rendering |
      |---|---|---|---|
      | before | `…/dashboard/portal/` | 0 | blank, asset 404 |
      | after | `…/dashboard/` | 1 | login page renders |

- [x] Confirm no console errors and no asset 404s after the fix
- [x] Full suite: 2224 pass / 0 fail
- [x] Stop the probe servers and the headless browser, remove the temporary
      profile directories, confirm no stray files in the repo

## Phase 6 — Handed over and finished

This change stopped at its release step, blocked on the version decision. Picked
up in the other session on Vin's instruction. Everything below was done by the
session that finished it, and the work above was verified rather than assumed:
the pure logic was re-derived by hand, the tests were re-run, the base href was
probed across every route shape against the real app, and the production
redirect claim in "Filed, not fixed here" was re-measured live.

- [x] Renumbered v1.26.42 → **v1.26.44**. v1.26.43 shipped while this change was
      paused, so 1.26.42 would have been a version going backwards.
- [x] **Fixed a real defect in the test file: 9 of its 25 tests depended on
      `src/public/dashboard/`, which is gitignored build output.** Measured by
      moving that directory aside to simulate a fresh clone: 9 failures. It was
      also the only test file in the repo with that dependency, so `npm test` on a
      fresh clone would have failed because of this change.
      - Added a fixture suite that builds its own shell and asset files in a temp
        directory, so the end-to-end invariant is proven with no build present.
      - Marked the tests that genuinely need the real built shell as conditionally
        skipped, with a message naming the command to run.
      - Measured after the review regrade: with a build, 33 tests, 33 pass, 0
        skipped. Without one, node reaches 26 of them: 21 pass, 5 skipped, 0 fail.
        Stated that way on purpose — node reports only the tests it reaches, so
        "33 with 5 skipped" would overstate the fresh-clone coverage by 7 tests.
- [x] The fixture helper was itself wrong on the first attempt: `withFixtureApp`
      was synchronous, so its `finally` removed the temp directory before the
      async test body ran and every request 404ed for the wrong reason. Made it
      `async` and awaited the callback.
- [x] Added a test proving the change is not a no-op: serve the same fixture the
      old way (raw `sendFile`) and assert the asset 404s and that its resolved path
      lands under `/dashboard/portal/assets/`.
- [x] Probed every route shape against the real app and confirmed each resolves an
      asset to `/ownmind/dashboard/assets/`: `/dashboard` (301 → `/dashboard/`),
      `/dashboard/`, `/dashboard/login`, `/dashboard/portal/handoffs`,
      `/dashboard/portal/handoffs/`
- [x] Re-measured the "Filed, not fixed here" claim on production rather than
      trusting it: `/ownmind/dashboard` → 301 `/dashboard/`, and
      `https://kkvin.com/dashboard/` → 200. The claim holds; no user-visible break.
- [x] CHANGELOG / FILELIST / README ×3
- [x] Version bump in `package.json` and `package-lock.json`
- [x] Quality gates

## Concurrency note

A parallel session worked the *other* Phase 12b item (the dashboard footer
reporting v1.20.1) in the same working tree at the same time — same directory, not
a separate worktree, which is what caused the entanglement below.

Both changes edit `src/app.js`, in different regions: this one the `/dashboard`
block, the other one the `/api/*` mounts. Textually they do not collide, but each
added an import of a file the other session had not committed, so a commit of
`src/app.js` by either side alone would have broken on a fresh checkout.

Resolved by the other session committing v1.26.43 with only its own hunks of
`src/app.js` staged (built as "HEAD + its two lines" and written straight to the
index), leaving this change's hunk unstaged and its files untouched. This change
then landed on top with the full file.

## Phase 7 — Code review round

Reviewer returned 0 Critical, 4 Important, 7 Minor. Every finding reproduced
before acting.

- [x] **Important: `relativeBaseHref` under-counted empty segments, and the comment
      asserted the wrong premise.** `split('/').filter(Boolean)` discards empty
      segments, but the URL resolver treats `//` as two levels. Measured against
      the real app: `/dashboard//portal//handoffs` and `/dashboard/a//b` both
      returned the shell with `../`, resolving assets to a directory that 404s —
      the blank page this change removes. Checked all 12 shapes against
      `new URL()`: the old formula was wrong on 6. Replaced with a count from
      `split('/').length - 2`, correct on all 12, and every previously-correct
      value is unchanged. Production was shielded because nginx merges slashes;
      the direct `localhost:3100/dashboard/` deployment was not.
- [x] **Important: a test enshrined that bug.** It asserted
      `relativeBaseHref('/portal//handoffs') === '../'` under a name presenting it
      as correct, so the defect could never surface. Now asserts `'../../'`, renamed
      to say why, and joined by a test that checks the *invariant* over all 12
      shapes rather than expected strings.
- [x] **Important: my suite-level skip withheld three tests that need no build** —
      including `a missing shell file falls through instead of becoming a 500`,
      which builds its own probe and is precisely the fresh-clone code path. Regraded
      to per-test skips: only the three that touch the real `/dashboard` mount are
      now conditional.
- [x] **Important: the `text/html` assertion could not go red** — Express's own 404
      page is also `text/html`, so it held whether the shell was served or not.
      (That is why the fresh-clone measurement came out at 9 failures, not 10.) Now
      also asserts status 200 and `<base` in the body.
- [x] Minor: one false claim. The proposal said the change fixes assets,
      `basename` *and* `API_BASE`. `API_BASE` was never broken: the regex at
      `client/src/api/client.js:29` tolerates trailing segments, so it yielded
      `/ownmind` from the poisoned base too. Verified both ways. Corrected in the
      proposal, the CHANGELOG, and noted in the spec scenario.
- [x] Minor: `res.send` does not set `Cache-Control`, which the replaced
      `res.sendFile` did. With neither that nor `Last-Modified`, heuristic freshness
      is up to the cache, and a cache holding this shell would serve hashed asset
      references that no longer exist after a deploy — the same failure class.
      Restored `public, max-age=0`.
- [x] Minor: the comment said "file extension" while the code tests for any dot.
      Reworded to describe what it does, and to record that a future route with a
      dot in a segment needs it tightened.
- [x] Minor: removed a dead `withFixtureApp` wrapper around the "unpatched
      behaviour" test, which built its own fixture and never used the one it was
      handed.
- [x] Minor: documented why the `['', './']` case is unreachable and what it
      actually pins.
- [x] Reviewer confirmed no Critical, and independently verified the security claim
      (crafted request paths cannot influence the emitted base), that no
      cache-poisoning angle was added, that the red-green is genuine rather than a
      strawman, and that the fix is complete — only `main.jsx:24` and
      `client.js:28` consume `document.baseURI`, with no lazy imports or relative
      fetches riding on the base.

## Known limitation

The rewrite lives in Express. If the shell is ever served by a static file host
with its own SPA fallback, that host has to do the same rewrite, or deep links
break again. Nothing in the repo does this today.

**The vite dev server is not covered.** Surfaced by review: `npm run dev` serves the
same unrewritten `<base href="./" />` for deep routes. Assets still load, because
dev references them absolutely (`/src/main.jsx`), but `basename` becomes `/portal`
and the route falls through to the `*` placeholder instead of the page. Different
symptom, same root cause, development only.

## Filed, not fixed here

- [ ] `GET /ownmind/dashboard` (no trailing slash) 301s to `/dashboard/`, dropping
      the `/ownmind` prefix, because `serve-static` builds the redirect from the
      path Express sees. On kkvin.com the bare `/dashboard/` is also proxied, so it
      currently lands on a working page and there is no user-visible break.
      `src/app.js` already solves this shape for `/me` with a relative
      `301 → 'me/'`. Left out to hold this change to one defect.
