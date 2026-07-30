# Single-console consolidation — Tasks

Legend: `[ ]` pending · `[x]` done

Each stage ships as its own release and gets its own version-prefixed OpenSpec
change folder, which carries the detailed task list for that stage. This file is the
program-level ledger: what each stage must achieve and what it must not break.

Every stage follows the project's standard flow: reproduction or behaviour test
first, then implementation, then CHANGELOG / FILELIST / README (three locales), then
the three quality gates. New code and internal docs in English per the project i18n
rule; CHANGELOG and FILELIST stay Chinese to match the existing files.

## Stage 0 — Real session identity

**Blocks every later stage.** Building any admin page on a hardcoded
`'super_admin'` would show admin navigation to every member.

- [ ] Establish where the console can read the current user's role and display name.
      `GET /api/me/profile` already exists; confirm it returns role before adding a
      new endpoint
- [ ] Replace `useState('super_admin')` in `client/src/App.jsx` with server-sourced
      identity. Remove the `profile: { name: 'User' }` placeholder in the same block
- [ ] Implement logout: clear the stored credential and return to `/login`, replacing
      the `console.log('logout')` stub
- [ ] Implement `onOpenProfile`, or remove it if the profile route already covers it
      (YAGNI check before building)
- [ ] Add route-level role guards. `RequireAuth` and `RequireFreshPassword` check
      only whether a session exists; add the equivalent for *which* role
- [ ] Tests: a `user`-role session sees neither 管理 nor 超級管理 in the sidebar;
      a typed `/admin/team` URL does not render; identity is not a literal
- [ ] Verify against the real server rather than a mocked role, using a
      non-super_admin account

## Stage 1a — Port the missing `/me/` features and put up the signposts

Order is load-bearing: signposts must exist before `/` is flipped in 1b, or the new
landing page has no route to user management.

- [ ] Remove 稽核記錄 from `Sidebar.jsx` (no API, no old-console counterpart, not
      requested). This leaves four of the five existing placeholders
- [ ] Turn those four into signposts: state that the feature still lives in the old
      console and link across. Replaces the current "coming soon" text, which is
      untrue
- [ ] Add the 工作紀錄 nav item and route **as a signpost** in this stage, not in
      Stage 4. It is the one feature with no seat in the current navigation, and
      without a seat it stays invisible until Stage 4. Its real page arrives in
      Stage 4
- [ ] Signpost count after this stage: five (使用者管理, 錯誤回報, 系統設定, 廣播管理,
      工作紀錄)
- [ ] Build the Requirement 5 manifest now, while there are five signposts to record:
      one place holding each old-console feature's state, read by the signpost routes,
      the nav items **and** the `/admin` mount decision. This is the structural guard
      that replaces a red test, because a red test gates nothing in a repo with no CI
- [ ] Make `/admin` an either/or driven by the manifest: while any signpost remains,
      serve the old console statically; once none do, answer with the retirement
      redirect instead. Install **both** branches now, with the redirect dormant, so
      the switch has no gap. Building the redirect only in Stage 5 would leave
      `/admin/` 404ing between Stage 4 and Stage 5
- [ ] Test both directions: a manifest with zero signposts does not serve `/admin/`
      and does redirect it; a manifest with one signpost serves it and does not
      redirect. Proving only one direction lets the guard pass vacuously
- [ ] Hand the credential across when a signpost is followed, so the old console is
      already authenticated. The three consoles store the key under three different
      names (`om_api_key`, `ownmind_api_key`, `ownmind.api_key`) so they never clobber
      each other, but the **value** is the same `users.api_key` row whichever endpoint
      issued it. Write the value plus `om_role` / `om_user_id` / `om_user_name` from
      the identity Stage 0 already fetched. Same-origin only
- [ ] Port narrative analysis as its own route, served by `/api/me/narrative` and
      `/api/me/narrative/insights`
- [ ] Port 踩坑紀錄 as its own route, served by `/api/me/pitfalls`
- [ ] Confirm both new routes cover what `/me/` rendered, section by section
- [ ] Browser check on production after deploy, per the iron rule

**Done when**: nothing about where users land has changed, and everything needed for
1b is in place. Shipping this alone is safe, which is the point of the split.

## Stage 1b — Flip the entry point and retire `/me/`

Split from 1a on adversarial review: bundling the port, the signposts, the entry flip
and the retirement into one release means any single failure removes every user's way
in. 1a must be live first.

- [ ] Change `src/app.js:155` from the hardcoded `/ownmind/admin/` to a **relative**
      redirect to the console
- [ ] `/me` and `/me/*` → relative 301 to the console's usage route, following the
      existing relative-redirect pattern at `src/app.js:89`. A blanket redirect is
      safe: `/me/` keeps no state in the URL, so no deep link is lost. Confirmed by
      measurement, since adversarial review predicted otherwise
- [ ] Move `src/public/me/` to a legacy name with a header comment; confirm it is no
      longer reachable
- [ ] Sync `Dockerfile` COPY directives with the move
- [ ] Tests: root redirect resolves correctly both with and without the `/ownmind`
      prefix; `/me/` 301 keeps the prefix; no redirect target in `src/app.js`
      contains a hardcoded `/ownmind`
- [ ] Browser check on production after deploy, including following a signpost to the
      old console and confirming no second login is demanded

**Done when**: three consoles become two, and the new console is the default entry
point with no feature lost.

## Stage 2 — 使用者管理

First of the rebuilds, because it is the only feature whose absence forces a trip
back to the old console.

- [ ] Inventory what the old `users` tab does before building: list, create, role
      assignment, password reset, deactivate. Read `src/routes/admin.js` and
      `src/routes/admin-password-reset.js` rather than inferring from the UI
- [ ] Build `/admin/team` against the existing APIs; add no new endpoint unless the
      inventory proves one is missing
- [ ] Destructive actions follow the project's UI rule: delete controls are red and
      kept away from edit controls
- [ ] Flip this feature's manifest entry to `live`, which removes its signpost
- [ ] Tests: `admin` and `super_admin` reach it, `user` does not; each inventoried
      action works
- [ ] Browser check on production after deploy

## Stage 3 — 系統設定 + 廣播管理

One old tab split across two pages. Done together because they share an origin.

- [ ] `/super/config`: 成本設定 (model pricing) and 裝機狀況, both from the old
      settings tab
- [ ] `/super/broadcast`: broadcast management against `/broadcast/admin`, the same
      API the old console calls
- [ ] Confirm nothing else was hiding in the old settings tab beyond these three
      blocks
- [ ] Flip both manifest entries to `live`, which removes both signposts
- [ ] Tests: `super_admin` only; creating, ending and listing broadcasts behave as in
      the old console
- [ ] Browser check on production after deploy

## Stage 4 — 錯誤回報 + 工作紀錄

Both read-only observability pages, so lowest risk, so last.

- [ ] `/admin/bugs` against `src/routes/bug-reports.js`
- [ ] Replace the `/super/work-log` signpost added in Stage 1a with the real page,
      against `GET /api/admin/work-log` and its `/filters`
      companion: the merged activity / compliance / session timeline, with the
      filters the API already supports
- [ ] Flip both manifest entries to `live`. This empties the manifest, so by
      Requirement 5 the old console stops being served and starts redirecting, with no
      further edit. Confirm that actually happened rather than assuming it: request
      `/admin/` and observe the redirect
- [ ] Tests: role gating for each; filters and pagination behave
- [ ] Browser check on production after deploy

## Stage 5 — Clean up after the automatic retirement

By Requirement 5, `/admin/` already stopped serving and started redirecting the moment
Stage 4 emptied the manifest. This stage is the cleanup that the redirect does not do
by itself: preserving the source, dropping the now-dead code path, and closing the
record.

- [ ] Confirm the 鐵律升級 open item with Vin before deleting: the old tab reports
      `total / skill_md_format / legacy_text`, which answers whether the legacy-text
      migration ever completed
- [ ] Verify on production that `/admin/` and `/admin/*` really are redirecting, and
      that the redirect is relative so the `/ownmind` prefix survives
- [ ] Delete the now-unreachable `express.static(join(__dirname, 'public'))` branch,
      which also resolves the whole-`src/public/` exposure and its duplicate URLs
- [ ] Move `src/public/index.html` to a legacy name with a header comment
- [ ] Confirm `/setup` still resolves; it is served by an explicit route, not by the
      removed static mount
- [ ] Sync `Dockerfile` COPY directives
- [ ] Confirm the Requirement 5 guard was doing real work: check out the Stage 3 state
      and observe that `/admin/` was still served then, rather than trusting that the
      switch fired
- [ ] Close the loop on `openspec/changes/archive/v1.20.4-legacy-retire/`, the stub
      this program supersedes
- [ ] Browser check on production after deploy

**Done when**: one console.

## Deliberately out of scope

- `/setup` stays a separate unauthenticated bootstrap flow
- `/super/audit` is not built; it is removed from the navigation in Stage 1a
- 鐵律升級 is not ported
- The seven already-working pages are not redesigned

## Cross-cutting checks for every stage

- [ ] Redirects relative, never absolute (Requirement 4)
- [ ] Role gating tested at both sidebar and route level (Requirement 2)
- [ ] Manifest entry flipped to `live`, and the effect on `/admin` observed rather
      than assumed (Requirement 5)
- [ ] Server and client both reviewed, per the project rule that a functional change
      must be checked at both ends
- [ ] CHANGELOG / FILELIST / README ×3 updated in the same change, not at commit time
- [ ] Any test data created on production is cleaned up afterwards
