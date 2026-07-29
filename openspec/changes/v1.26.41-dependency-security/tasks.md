# v1.26.41 — Tasks

Legend: `[ ]` pending · `[x]` done

## Phase 0 — Establish the real state before touching anything

- [x] Enumerate open alerts from the API rather than the push banner:
      37 open, 10 high / 24 medium / 3 low, across three lockfiles
- [x] Map every alert to the fix it needs, and confirm each is inside a range the
      manifests already accept (all but one)
- [x] Confirm the repository has no `.github/workflows/`, so "no checks reported"
      on PR #45 means no CI exists, not that CI failed
- [x] Check whether `client/` is actually shipped: the Dockerfile builds it in
      stage 1 and copies the output to `src/public/dashboard/`, so it is

## Phase 1 — Verify PR #45 before merging it

- [x] Fetch `refs/pull/45/head` into an isolated worktree
- [x] `mcp/`: `npm ci` clean; `index.js` genuinely imports with the new tree
- [x] `client/`: `vite build` succeeds on vite 8.1.5
- [x] Establish a baseline build on `main` for comparison, rather than judging the
      new output in isolation
- [x] Compare: CSS hash byte-identical (`index-obDkY7bq.css`), JS differs 0.02 kB
- [x] Record the one new build message (`SOURCEMAP_BROKEN` from
      `@tailwindcss/vite`) as cosmetic, absent before, not fixed here
- [x] Approve with the verification attached, squash-merge as `cc213fd`,
      remove the worktree and the temporary branch

## Phase 2 — Root-cause the remaining alerts

- [x] `js-yaml` is a direct root dependency; `^4.1.1` already accepts 4.3.0
- [x] Trace reachability: `src/utils/iron-rule-frontmatter.js` parses iron-rule
      frontmatter, reached client-side via `hooks/lib/conditional-sync-cli.js`,
      and shared team standards come from other accounts
- [x] `react-router`: 4 of 5 advisories patched at 7.18.2, inside `^7.10.0`
- [x] `@hono/node-server`: MCP SDK 1.30.0 widens the range to `^2.0.5`
- [x] `body-parser` in root: inside express's `^2.2.1`
- [x] `GHSA-qwww-vcr4-c8h2`: no `react-router-dom` 8.x exists on npm, and
      `npm audit fix --dry-run` produces no change. Grepped `client/src/` for nine
      RSC/SSR entry points — none present, so the advisory does not apply

## Phase 3 — Discover that the bump cannot reach a user machine

- [x] Grep `install.sh` / `interactive-upgrade.sh` / `update.sh` for `npm install`:
      only `mcp/` is ever installed; root deps come from one line in `update.sh`
- [x] Read that line: guarded by `[ ! -d .../node_modules/js-yaml ]`
- [x] Prove it on a real machine rather than reasoning about it:
      repo lock 4.3.0 vs `~/.ownmind/node_modules/js-yaml` 4.1.1
- [x] Confirm the delivery order is safe: the upgrade command in
      `src/routes/memory.js:486` git-pulls before running `update.sh`, so a new
      helper file is present by the time it is called

## Phase 4 — RED tests

- [x] Create `tests/dep-floor-guard.test.js`
- [x] Comparison: below / at / above, multi-digit segments, prereleases
- [x] Fail-safe: absent package, no `version` field, invalid JSON, unparseable input
- [x] Scoped package names (`@hono/node-server`)
- [x] CLI contract: exit 0 / 1, silence on stdout, missing arguments exit 1
- [x] Drift guards: helper referenced, no directory check survives, script floor
      at or above `package.json`, install range at or above the gate
- [x] Run and confirm RED for the right reason (helper module does not exist)

## Phase 5 — Implementation

- [x] `scripts/install-helpers/dep-floor.mjs` — `parseVersion`, `satisfiesFloor`,
      `readInstalledVersion`; pure library, no side effects on import
- [x] `scripts/install-helpers/dep-floor-cli.mjs` — the shell-facing predicate
      (split out during the review round, see Phase 10)
- [x] `scripts/update.sh` — `needs_root_dep`, both root deps moved to it
- [x] `scripts/update.ps1` — `Test-RootDepNeeded`, both root deps moved to it,
      Chinese comments in the touched block translated per the project i18n rule
- [x] `package.json` — `js-yaml` floor `^4.1.1` → `^4.3.0`
- [x] Lock updates: root (`js-yaml` 4.3.0, `body-parser` 2.3.0), `client/`
      (`react-router-dom` 7.18.2), `mcp/` (SDK 1.30.0, `@hono/node-server` 2.0.12)
- [x] New tests green (24), full suite green (2181)

## Phase 6 — Verify beyond the unit tests

- [x] Mutation-test all four drift guards; each fails when subverted, and the
      baseline is restored afterwards:
      manifest lowered → 1 fail, gate lowered → 1 fail, directory guard restored
      → 3 fail, install range below gate → 1 fail
- [x] Behavioural test of the real `needs_root_dep` body extracted straight out of
      `update.sh` with `sed`, against a fake install directory:
      4.1.1 → install, 4.3.0 → skip, 4.3.1 → skip, absent → install,
      corrupt manifest → install
- [x] `client/` rebuild on react-router 7.18.2: succeeds, CSS hash unchanged
- [x] `mcp/` `npm ci` + real import on SDK 1.30.0: clean, `found 0 vulnerabilities`
- [x] `npm audit` in `client/`: only `GHSA-qwww-vcr4-c8h2` remains, as expected
- [x] Confirm the Dockerfile needs no new `COPY`: `dep-floor.mjs` is invoked only
      by the update scripts on user machines; server code reads only
      `scripts/bootstrap.{sh,ps1}`

## Phase 7 — Not verified, and stated as such

- [ ] `scripts/update.ps1` was **not executed**. No PowerShell on this machine
      (`pwsh` and `powershell` both absent). Reviewed line by line, twice, and
      hardened for two hazards found by reading (see Phase 10), but the wiring
      itself is unproven until it runs on Windows. Its polarity and its use of
      `-ne 0` are pinned by source assertions, which is the practical substitute,
      not a substitute for running it.

## Phase 10 — Code review round

Reviewer returned 1 Critical, 4 Important, 5 Minor. Every finding was reproduced
against the actual code before anything was changed.

- [x] **Critical: the CLI silently exited 0 when reached through a symlink.**
      `process.argv[1]` compared against `import.meta.url` with `path.resolve`,
      which is lexical, while node realpaths the main module. Any symlinked path
      component made them differ, the body was skipped, and exit 0 reads as "floor
      met" — no install, ever, silently. Reproduced: impossible floor `9.9.9`
      through a symlinked path returned exit 0. Fixed structurally rather than by
      patching the comparison: `dep-floor.mjs` is now a pure library and
      `dep-floor-cli.mjs` always runs, so the third outcome does not exist. Pinned
      by a symlink test, and by a mutation reintroducing the old pattern (3 red).
- [x] **Important: `package-lock.json`'s own root block was stale** —
      `packages[""].version` 1.26.40 and `js-yaml` `^4.1.1` against a manifest
      saying 1.26.41 and `^4.3.0`. Every prior release kept these in step.
      Regenerated with `npm install --package-lock-only`; verified no other package
      moved.
- [x] **Important: the headline evidence was circular.** The "repo lock 4.3.0 vs
      machine 4.1.1" comparison presented a drift this change itself created —
      HEAD, `ee51619` and `15aa931` all have the lock at 4.1.1. Verified the
      reviewer's replacement instead of taking it on trust: `npm install
      js-yaml@^4.1.1 --no-save` against a lock pinning 4.1.1 really does install
      4.3.0. So the old command would always have delivered the patch and the guard
      was the sole blocker, which is both true and a stronger statement. Corrected
      in the CHANGELOG, the proposal, and both code comments.
- [x] **Important: `Test-RootDepNeeded` was unsafe under `Set-StrictMode -Version
      Latest`** (`update.ps1:15`). `& node` at line 86 is the script's first native
      command, so `$LASTEXITCODE` does not exist yet; if node is absent the call
      throws without setting it and StrictMode turns the read into an error rather
      than a value, so the documented "node missing means floor not met" guarantee
      did not hold on Windows. Now checks for the helper and for node explicitly.
      Deliberately not "fixed" by assigning `$LASTEXITCODE` inside the function:
      that creates a local shadowing the global, and every later read returns the
      stale local.
- [x] **Important: no test pinned the guard polarity.** Confirmed: deleting the `!`
      in `update.sh` or flipping `-ne` to `-eq` in `update.ps1` left all 24 tests
      green while inverting the behaviour. Added an assertion for each.
- [x] **Minor: `floorsFor` was order-dependent.** Re-anchored on the exact call
      syntax and made it strip comments. This was not theoretical — the corrected
      comment quoting `npm install js-yaml@^4.1.1` immediately made the loose
      version read the wrong number, and the test caught it.
- [x] Minor: documented that `satisfiesFloor` does not order two prereleases of the
      same triple, and why that cannot arise here
- [x] Minor: node's stderr now goes to `~/.ownmind/logs/update-err.log` instead of
      `/dev/null`, so a permanently broken node leaves a trace
- [x] Minor: recorded that `install.sh` installs no root deps at all, and why that
      is being left alone
- [x] Minor: noted that `npm audit fix --dry-run` advertises a fix it will not apply

## Phase 10b — Found while fixing the review, not raised by it

- [x] The new stderr redirect depended on `~/.ownmind/logs/` existing, and
      `send_update_beacon` only creates it on its spool fallback. A failed `2>>`
      redirect fails the whole command, the negation flips, and the install reruns
      on every sync. Surfaced when the new behavioural test reported INSTALL for
      every case — including the ones that should skip — which also means the first
      assertion had been passing for the wrong reason. `update.sh` now creates the
      directory before the guard, which also hardens the `npm install` redirects
      that have assumed it since v1.18.5. The test takes that line from the script
      rather than hardcoding it, so removing it turns red.

## Phase 10c — Re-verification after the review fixes

- [x] 27 tests green (24 → 27), full suite green
- [x] Mutation battery re-run at 8 mutations, all caught: manifest floor lowered
      (1 red), sh gate lowered (1), directory guard restored (3), install range
      below gate (1), sh polarity inverted (2), ps1 polarity inverted (1), log
      mkdir removed (1), self-detecting CLI reintroduced (3). Baseline restored.
- [x] Behavioural run of the shipped shell guard, now with real preconditions:
      4.1.1 → install, 4.3.0 → skip, 4.3.1 → skip, absent → install, helper
      deleted → install, and no shell errors on stderr in any case

## Phase 8 — Docs and version

- [x] `openspec/changes/v1.26.41-dependency-security/` — proposal, spec, tasks
- [x] `CHANGELOG.md` — v1.26.41 entry
- [x] `FILELIST.md` — register the new helper and test, and the changed files
- [x] `README.md` + `docs/README.zh-TW.md` + `docs/README.ja.md` — checked
- [x] Bump `package.json` to 1.26.41

## Phase 9 — Quality gates (mandatory)

- [x] `superpowers:verification-before-completion`
- [x] `superpowers:requesting-code-review`
- [x] `superpowers:receiving-code-review` — every finding reproduced against the
      shipped code before acting, including the reviewer's replacement claim; see
      Phase 10

## Phase 12 — Release

- [x] Commit `2235845`, no Co-Authored-By, author Vin
- [x] Tag `v1.26.41` pushed
- [x] Deployed to kkvin.com, pinned to the tag rather than a branch, with the
      previous image kept as `ownmind-api:prev-v1.26.40` so it survives a prune
- [x] Migrations run as a deploy step: 17 already applied, 0 new, "DB schema is up
      to date" — the expected no-op, no schema change in this release
- [x] `docker compose build --no-cache`, then `up -d`. The in-container client
      build produced JS hash `index-iF1ipOZR.js`, byte-identical to the local
      build, so the image is reproducible
- [x] Verified inside the running container: js-yaml 4.3.0, body-parser 2.3.0
- [x] Live `GET /api/memory/init` reports `server_version 1.26.41` and is already
      advertising the upgrade to clients
- [x] Browser check on the dashboard: loads clean, no console errors, and
      client-side routing exercised across `/portal/usage`, `/portal/handoffs` and
      `/admin/bugs` with `NavLink` active state tracking correctly — which is what
      the react-router 7.18.2 upgrade actually touches
- [x] Browser check on the legacy admin console: user count 9 and
      我的記憶（啟用中） 388, so v1.26.39's fix is also good in production. An
      earlier screenshot showing `-` was the pre-fetch state, not a failure:
      `/api/export` returns 950 kB and takes about a second
- [x] Alerts: 37 → 1 → 0 after dismissing the inapplicable one as `not_used` with
      the reasoning recorded on the alert
- [x] Cleaned up: deploy script and log removed from the server, plus a stale
      `ownmind-deploy-v1.26.36.log` left behind by an earlier release

## Phase 12b — Found during the post-deploy browser check, unrelated to this change

Both confirmed pre-existing and left alone rather than folded in.

- [ ] **A hard load of any dashboard sub-route renders a blank page.** Express
      serves the SPA shell for `/ownmind/dashboard/portal/handoffs`, but
      `client/index.html` carries `<base href="./">` and `client/vite.config.js`
      sets `base: './'`, so the asset request resolves to
      `/ownmind/dashboard/portal/assets/...` and 404s. Measured: that path returns
      404 while `/ownmind/dashboard/assets/...` returns 200. Clicking through the
      sidebar works, so this only bites on a bookmark, a refresh, or a shared link.
      Introduced in v1.20.0 / v1.20.1 (`cd43c41`, `f4e1fc1`); `git diff
      v1.26.40..v1.26.41` shows this change touched neither file.
- [ ] **The dashboard footer and sidebar report v1.20.1.** `client/src/App.jsx:61`
      hardcodes `version: 'v1.20.1'`, and the changelog entries above it are
      hardcoded too. Stale for 21 releases. Should read the version the server
      already returns rather than a literal.

## Phase 13 — Filed, not done here

- [ ] **No CI.** The repository has no `.github/workflows/`, which is why PR #45
      sat unverified. Needs its own decisions: which runner, which suites, whether
      it gates merges.
- [ ] **`GHSA-qwww-vcr4-c8h2` stays open.** Not applicable (static SPA, no RSC),
      and clearing it needs a react-router v8 migration. Either dismiss it in
      Dependabot as not-used, or accept a permanent alert on a public repository.
- [ ] **`sourcemap: true` in `client/vite.config.js`** ships a 3.2 MB `.map` into
      the production image.
- [ ] Each user must sync their local `~/.ownmind` before the js-yaml upgrade
      reaches their machine. The new guard is what makes that sync effective; it
      cannot upgrade anyone retroactively.
