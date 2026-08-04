# v1.26.57 — bare mount path tasks

## Phase 0 — Inventory

- [x] Reproduced on production with curl, then again **against the container directly**
      on `127.0.0.1:3100` — identical `Location`, so it is the app and not nginx
- [x] Mapped the whole surface, not just the reported path. Four entry points checked:
      `/ownmind/dashboard` ✗, `/ownmind/admin` ✗, `/ownmind/setup` ✓, `/ownmind/me` ✓.
      The two broken ones are the repo's only two `express.static` mounts; the two
      correct ones are redirects v1.26.48 already converted
- [x] Confirmed the landing page: `https://kkvin.com/dashboard/` answers 200 with an
      unrelated site titled "Vin WorkSpace". Not a 404 — the user ends up somewhere that
      looks deliberate
- [x] Confirmed not introduced by v1.26.56: `src/app.js` last changed in v1.26.48 and
      the stats release touched no routing

## Phase 1 — Spec

- [x] `proposal.md`, `spec.md` (5 requirements), this file
- [x] Recorded why `{ redirect: false }` alone is wrong: `/dashboard` would fall to the
      SPA shell handler, which computes `<base href>` for the wrong depth — the
      v1.26.44 blank page

## Phase 2 — Tests first (RED)

- [x] `tests/bare-mount-trailing-slash.test.js`, confirmed red (module not found)
- [x] Assertions resolve the emitted `Location` against **two** bases, following
      `tests/stage-1b-flip-root-retire-me.test.js`. A string comparison passes for the
      broken absolute form, which is how this survived v1.26.48

## Phase 3 — Implementation

- [x] `src/middleware/bare-mount-redirect.js`, installed before both static mounts
- [x] Middleware rather than `app.get(mountPath)`: the latter also matches
      `/dashboard/` under non-strict routing, and redirecting that to `dashboard/`
      resolves to `/dashboard/dashboard/` — a loop worse than the bug

## Phase 4 — Review

Round 1 found no Critical, but three request shapes that **slipped past the first
version of the guard straight back into serve-static's absolute redirect**. Each was
verified by probing the running app before being accepted, and each now has a test:

- [x] **Case variants.** Express mounts are case-insensitive by default, so
      `/Dashboard` entered the mount while a case-sensitive comparison let it through.
      Measured: `Location: /Dashboard/` → `http://x/Dashboard/`, the production bug
      unfixed. Comparison is now case-folded, which also normalises the path
- [x] **Absolute-form request line.** `GET http://evil.example/dashboard HTTP/1.1` made
      serve-static emit `Location: http://evil.example/dashboard/`, reflecting a
      client-supplied host. Matching now runs on the parsed pathname, and the depth for
      `relativeRedirectTarget` comes from that pathname rather than the raw
      `originalUrl` — which would otherwise have counted the scheme and host as two
      directories and emitted `../../dashboard/`
- [x] **Non-GET methods.** serve-static only redirects GET and HEAD; the first version
      answered POST with a 301 where the app previously 404ed. A behaviour change
      smuggled in by a bug fix. Now filtered
- [x] The `/admin` test was the weakest in the file: it asserted only "relative, and
      somewhere under the prefix", which stays green even if the helper sent `/admin` to
      `dashboard/`, and it could not tell the static branch from the retired one. Split
      by `isLegacyConsoleRetired()`, each branch asserting its real destination
- [x] The structural test hardcoded two filenames, so a new `express.static` in a new
      file — the exact case it exists to catch — would have slipped by. Walks all of
      `src/` now
- [x] Removed the unused `opts.code`; tightened `MOUNT_PATH` so `/..` and `/.` are
      refused; documented that the helper is top-level-app only
- [x] **Rejected one recommendation, with reasoning**: adding `{ redirect: false }` as
      defence in depth. Once matching is correct nothing reaches serve-static's
      redirect, and in the case where matching is *wrong* it converts a wrong redirect
      into a blank page. That is a different failure, not a smaller one
- [x] **Found while verifying**: the new test file leaked a server handle and reported
      the file as cancelled. `srv.close()` waits for live connections; destroying the
      client socket is not enough. `closeAllConnections()` fixed it. The residual 60s
      standalone runtime is pre-existing — `tests/stage-1b-flip-root-retire-me.test.js`
      takes the same 60s, because importing `src/app.js` leaves a handle open. Out of
      scope, recorded

## Phase 5 — Quality gates

- [x] Ten mutations, each turning the suite red: case-sensitive compare, depth from raw
      url, no method filter, no normalisation, no exact-path check (the loop), absolute
      Location (the original bug), dropped query, permissive validator, and each of the
      two installs removed
- [x] Full suite green, e2e green
- [x] `superpowers:verification-before-completion`
- [x] `superpowers:requesting-code-review`
- [x] `superpowers:receiving-code-review`

## Phase 6 — Release

- [ ] Version 1.26.57 in `package.json` and the three READMEs
- [ ] `CHANGELOG.md`, `FILELIST.md`
- [ ] Commit, tag, push, deploy kkvin.com
- [ ] Verify the fixed paths on production with curl, including the case variants
