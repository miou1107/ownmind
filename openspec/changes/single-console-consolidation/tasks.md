# Single-console consolidation — Tasks

Legend: `[ ]` pending · `[x]` done

Nine stages. Each ships as its own release with its own version-prefixed OpenSpec
change folder carrying the detailed task list. This file is the program ledger.

Every stage follows the project's standard flow: behaviour test first, then
implementation, then CHANGELOG / FILELIST / README (three locales), then the three
quality gates. New code and internal docs in English per the project i18n rule;
CHANGELOG and FILELIST stay Chinese to match the existing files.

Design reference: the clickable prototype agreed with Vin on 2026-07-30. Its
presentation rules are Requirement 7 and apply to every stage, not only the pages
that surfaced them.

## Stage 0 — Real session identity

**Blocks every later stage.** Building any admin page on a hardcoded
`'super_admin'` would show admin navigation to every member.

- [x] Identity comes from `GET /api/me/profile`, which returns `{ id, name, email,
      role, must_change_password }` and resolves the user from the api_key server-side.
      No new endpoint needed
- [x] Replaced `useState('super_admin')` and the `profile: { name: 'User' }` placeholder
      with a `SessionProvider`. **The role is deliberately not persisted**: the old
      console kept it in the user-writable `om_role` key, so a member could edit it to
      reveal admin cards. In memory only, refetched per load
- [x] Logout clears the credential and dispatches the existing `auth-expired` event, so
      logout and token expiry share one route back to `/login`
- [x] `onOpenProfile` removed rather than implemented. Its two menu items both called an
      unimplemented callback, and the sidebar already has the whole 偏好設定 section, so
      they were duplicate navigation. Collapsed to one item linking to
      `/preference/profile`
- [x] Role simulator removed, with its `header.role_simulator` key deleted from all
      three locales. A control that lets you change your own role is either dead or
      shows a view the server disagrees with
- [x] Added `RequireRole`. It checks readiness before deciding, so a hard load does not
      bounce an admin out of an admin page while the identity is in flight
- [x] Added `tests/console-session-identity.test.js`, 22 tests. The role ladder was
      split into `client/src/session/roles.js` so the part that decides who gets in is
      **executed** rather than read: five tests run `roleAtLeast`, including
      fail-closed on an unknown role and on an unknown requirement
- [x] Mutation-tested both new guards, confirming the mutation applied before trusting
      the red. Full suite 2259 pass / 0 fail; client build exit 0
- [x] Fixed a pre-existing assertion from v1.26.43 that pinned
      `<RequireAuth><RequireFreshPassword><Layout>` as adjacent. Inserting a guard broke
      the match without breaking the invariant. Relaxed to allow intervening guards, and
      mutation-tested that it still catches a missing `RequireAuth`
- [x] Code review round: 1 Critical, 7 Important, 7 Minor, each reproduced before acting.
      The Critical was a deterministic defect, not a race: LoginPage calls `setApiKey` and
      `navigate` in one synchronous block, so an admin arriving from a deep link always
      landed on `/portal/usage`. Fixed by seeding the session from the login response,
      which also removes a round trip. Two rounds of my own test-writing failed to catch
      it — first a source-text ordering assertion that passes for the broken ordering,
      then extracting `decideRoleGate` without testing it. Mutation testing found the
      second miss. Also fixed: the ladder failed **open** on `Object.prototype` keys; the
      sidebar-versus-guard test checked vocabulary rather than agreement; the logout test
      was trivially green; event names were duplicated string literals; an identity error
      was indistinguishable from being logged out; the shell flashed an empty sidebar and
      a wrong role badge on every load. Suite 2271 pass / 0 fail
- [x] Released and deployed 2026-07-30. `v1.26.45` on `/VinService/ownmind`,
      `docker compose build --no-cache api` then `up -d api`. No migrations in this range.
      The served asset hash changed from `index-C86s0nQQ.js` to `index-CT4WxB9R.js`,
      matching the local build byte for byte. Container up, no errors in the logs.
      **Correcting two things I asserted earlier without checking**: this repo has no CI
      at all, so pushing a v tag deploys nothing (I had assumed idaytour's v-tag pipeline
      applied here); and `root@kkvin.com` accepts key-based SSH, so the earlier claim that
      the production database was out of reach was also wrong. Recorded in OwnMind
      memory 745
- [x] Post-deploy browser check, super_admin path: the top bar shows the real name and the
      real role badge instead of the hardcoded `'User'`; the role simulator is gone; the
      footer and sidebar read v1.26.45. A cold hard load of `/dashboard/super/config` and
      `/dashboard/admin/team` lands on the page rather than bouncing to `/portal/usage`,
      which is the readiness gate working in production. No console errors on either.
      `<base href="../">` still correct, so v1.26.44's fix is intact
- [ ] **Outstanding, needs Vin**: verify with a non-super_admin account that the 管理 and
      超級管理 sections are absent and that a typed `/dashboard/admin/team` bounces. This
      requires a member's login, which is not something I should handle
- [ ] **Outstanding, deferred with reason**: the api client has no request timeout, so a
      hung `/api/me/profile` leaves an admin route blank with nothing logged. It is a
      shared client affecting every request, so changing it reaches wider than this stage

### Surfaced by review, needs its own stage

- [ ] **`must_change_password` is enforced only in the browser.** `getMustChangePassword()`
      (`client/src/api/auth.js`) reads a user-writable localStorage key and
      `RequireFreshPassword` gates on it. **Nothing server-side blocks requests from an
      account in that state** — grep of `src/middleware/` and `src/routes/` returns only
      reads and writes of the column, never a gate. A member can delete the key in
      devtools and keep using a default-password account indefinitely. Same class as the
      `om_role` spoofing this stage removed, in the same file this stage edited.
      `GET /api/me/profile` already returns the authoritative value and the session now
      carries it, so the client half is one line; the server half needs a middleware that
      refuses everything except the password-change endpoint

## Stage 1a — Port the missing `/me/` features, raise the signposts

Order is load-bearing: signposts must exist before `/` is flipped in 1b.

Shipped as `v1.26.46`.

- [x] Removed 稽核記錄 from the navigation, from `Layout.jsx`'s title map, and the three
      `nav.audit` locale keys. A test now fails if a nav item resolves to neither a page
      nor a signpost, which is the defect 稽核記錄 was
- [x] Regrouped into 我的 / 團隊 / 偏好設定 / 管理 / 系統. **Permission moved from the
      section to the item**, which the plan did not anticipate: 系統 holds 系統設定
      (admin+, matching the legacy 裝機狀況 card) beside 廣播管理 and 工作紀錄
      (super_admin, matching their `super-admin-only` markup and `superAdminAuth`
      routes). One role per section would have had to take 系統設定 away from the admins
      who use it today, or offer the other two to people the server refuses. A section
      now appears when at least one of its items does
- [x] Placeholders replaced with signposts. **Eight, not four.** The stage list said
      工作紀錄 was "the one feature with no seat today"; that line predates the correction
      that 統計儀表板, 團隊用量 and 週/月報 are also unbuilt. All eight get a seat, which
      is also what "flip the manifest entry to `live`" in Stages 2 to 7 requires
- [x] Signpost routes are role-guarded, with one rule the plan did not state: **the
      guard is never lower than the legacy console's own login requirement.**
      `POST /api/admin/login` filters `role IN ('admin','super_admin')`, so a signpost
      shown to a `user` sends them to a door that will not open. 週報月報 is the one
      feature where this bites: the report is per-user
      (`GET /api/session/report` filters `WHERE user_id = $1`) so it belongs to every
      member, but its signpost sits at admin until Stage 7 builds the real page.
      Asserted by test against the navigation's own `minRole`
- [x] `shared/legacy-console-manifest.js` holds each feature's state, read by the
      routes, the nav items and the `/admin` decision. Validated at load and fails
      closed: a misspelled state would read as "not a signpost", retiring the old
      console while a feature still needs it, so it throws instead
- [x] `/admin` is an either/or driven by the manifest, both branches installed with the
      redirect dormant. Extracted to `src/middleware/legacy-admin-mount.js` because
      `app.js` decides at import time from a module constant, which a test cannot vary
- [x] Both directions tested, and mutation-verified: making the mount ignore the
      retired flag turns the suite red
- [x] Credential handed across in `client/src/api/legacy-handoff.js`, same-origin
      localStorage writes only, with the role re-checked at the point of handover
- [x] Also added `#<tab>` deep-linking to the legacy console, which is **not on this
      list**. Without it every signpost reads "go to the old console and find the right
      tab yourself". Only honours a tab whose button is visible for the role, and is
      wrapped so a bad fragment falls back to the default tab
- [x] Narrative ported as `/portal/narrative`, with the 503 `no_api_key` degradation
      reproduced and distinguished from a transient failure
- [x] 踩坑紀錄 ported as `/portal/pitfalls`
- [x] `audit_findings` cards and the custom date range ported. The cards sit above the
      tab bar, not inside the personal tab: they warn that the numbers below may be
      incomplete, which applies to every tab
- [x] Requirement 7 applied to the narrative at the data layer, not the CSS.
      `collectSections()` now marks members with no data as unmeasured, because the
      payload is fed to an LLM that will turn an unmarked zero into a confident
      sentence. The system prompt gained a rule about it
- [x] Confirmed section by section against `/me/`: the me / team / projects tabs were
      already covered by `/portal/usage`; narrative's ten sections plus 給管理者的洞察
      and 給你的下一步動作 are all present; pitfalls' three sections and window filter
      are present. `renderProjectComplianceTable` in `/me/` is dead code, because
      `project_compliance` is hardcoded to `[]` server-side
- [x] Two second sources removed while here: `Layout.jsx`'s path-to-title map (its own
      comment admitted it was a second place to remember) and the duplicated app-base
      regex, now `appBase()` from the api client
- [x] Code review round: 1 Critical, 5 Important, 10 Minor, each reproduced before acting.
      **The Critical was that logout stopped working.** The signpost writes a usable
      `om_api_key`, and `clearApiKey()` cleared only the console's own key, so after an
      admin followed a signpost and logged out, the next person to open `/admin/` in that
      browser was restored as them with a key every `adminAuth` route accepts. Before this
      stage the browser held that credential in one place and the old console's logout
      cleared it; adding a second writer without a second clear broke the invariant.
      Also fixed: my fail-closed test never called the validator (deleting `validate()`
      left it green); `measured` was defined as "count in this period > 0", the mirror
      image of the bug it was meant to fix, so a member on leave read as having no data;
      I verified a decision with a regex over App.jsx's source, the exact antipattern the
      previous round removed from `roles.js`; the coverage banner said the ranking excluded
      unmeasured members when the table lists them; and the test counts were wrong in three
      documents. Suite 2304 pass / 0 fail
- [ ] Browser check on production after deploy
- [ ] **Needs Vin**: `/portal/narrative` is open to `user`, which is faithful to `/me/`
      today and to Requirement 3's "same endpoints, unchanged", but it means a member sees
      team-wide activity ranking and every colleague's per-rule compliance counts, while
      the same class of data in the 團隊 section is admin-only. Not changed unilaterally,
      because narrowing it would remove access members have today. Requirement 3 did not
      anticipate the tension with the new section model

**Done when**: nothing about where users land has changed, and everything 1b needs is
in place. Shipping this alone is safe, which is the point of the split.

## Stage 1b — Flip the entry point, retire `/me/`

- [ ] Change `src/app.js:155` from the hardcoded `/ownmind/admin/` to a **relative**
      redirect to the console
- [ ] Fix `src/middleware/first-run-redirect.js`. It intercepts only `/admin`,
      `/admin/*` and `/setup` (`:36`), so once `/` lands on the console a fresh
      install never reaches the wizard. Both its redirects are also absolute
      (`:56` `/setup`, `:61` `/admin/login`) and already drop the `/ownmind` prefix
- [ ] `/me` and `/me/*` → relative 301 to the console's usage route, following the
      pattern at `src/app.js:89`. A blanket redirect is safe: `/me/` keeps no state in
      the URL. Confirmed by measurement
- [ ] Fix the three tests that read `src/public/me/`: `tests/me-report.test.js:133,139`,
      `tests/me-pitfalls.test.js:162-185`, `tests/me-trailing-slash.test.js:38,58,64-69`.
      The last asserts by regex that `src/app.js` still contains the exact old `/me`
      conditional, so a blanket 301 fails it
- [ ] Move `src/public/me/` to a legacy name with a header comment; confirm unreachable
- [ ] Confirm the `Dockerfile` needs no COPY change. `Dockerfile:18` is a
      whole-directory `COPY src/ ./src/` with no per-file directives, so the correct
      action is to verify preserved snapshots are **not** shipped, not to add one
- [ ] Tests: root redirect resolves correctly with and without the `/ownmind` prefix;
      `/me/` 301 keeps the prefix; no redirect target in `src/app.js` **or**
      `src/middleware/first-run-redirect.js` contains a hardcoded `/ownmind`
- [ ] Browser check on production, including following a signpost and confirming no
      second login is demanded

**Done when**: three consoles become two, the console is the default entry point, no
feature lost.

## Stage 2 — 使用者管理

First rebuild: the only feature whose absence forces a trip back to the old console.

- [ ] Inventory the old `users` tab before building. It is more than a list: an
      installer-prompt generator (`src/public/index.html:270-287`), add / password
      reset / delete modals, and a single-admin warning banner (`:216-221`). Read
      `src/routes/admin.js` and `src/routes/admin-password-reset.js`
- [ ] Build `/admin/team` against existing APIs; add no endpoint unless proven missing
- [ ] Add the 用量資料 column per the prototype. This is the only page where every
      member is reviewed one by one, so it is the right place to surface whose data is
      missing
- [ ] Destructive actions per the project UI rule: delete is red and kept away from edit
- [ ] Flip this feature's manifest entry to `live`, removing its signpost
- [ ] Tests: `admin` and `super_admin` reach it, `user` does not; each inventoried
      action works
- [ ] Browser check on production

## Stage 3 — 系統設定 + 廣播管理

One old tab split across two pages. The pricing block is **not** ported; see Stage 8.

- [ ] `/super/config`: 裝機狀況 only. Per the prototype it leads with the
      "heartbeat yes, data no" state, which is what the old coverage metric hid
- [ ] Note the role error in the old tab: 設定 is revealed to admin+, not super_admin
      only (`src/public/index.html:1185-1190`), and 裝機狀況 carries no
      `super-admin-only` class. Mapping it to a super_admin-only section silently
      removes it from `admin`. Decide deliberately and record the decision
- [ ] `/super/broadcast` against `/broadcast/admin`, the same API the old console calls
- [ ] Confirm nothing else was hiding in the old settings tab beyond the three blocks
- [ ] Flip both manifest entries to `live`
- [ ] Tests: role gating; creating, ending and listing broadcasts behave as before
- [ ] Browser check on production

## Stage 4 — 錯誤回報 + 工作紀錄

Both read-only observability pages, lowest risk.

- [ ] `/admin/bugs` against `src/routes/bug-reports.js`, including the reports / spam
      sub-tabs (`brSwitchSub`, `src/public/index.html:1556`)
- [ ] Replace the `/super/work-log` signpost with the real page, against
      `GET /api/admin/work-log` and `/filters`: the merged activity / compliance /
      session timeline with the filters the API already supports
- [ ] Flip both manifest entries to `live`
- [ ] Tests: role gating for each; filters and pagination behave
- [ ] Browser check on production

## Stage 5 — 統計儀表板

Vin uses this page and wants it ported in full. The largest single stage.

- [ ] Port all 17 blocks. Sources: `/api/activity/stats/all`,
      `/api/activity/stats?user_id=`, `/api/activity/stats/rules?user_id=`
      (`src/public/index.html:2786,2812,2876`). The console currently calls **none** of
      `/api/activity/*`, so this is a new integration, not a move
- [ ] Two views as today: all-user overview and single-user detail, with the
      7 / 30 / 90-day range
- [ ] Blocks: 用戶活躍度總表, 記憶數量卡片, 記憶類型分布, 工具分布, 模型分布,
      每日活動量, 鐵律合規率, 各規則落地率, 各工具落地率, 每條鐵律落地率表,
      從未被觸發的規則, 鐵律觸發 Top 5, 系統健康, 常用操作, 專案分布, 使用者痛點,
      AI 改善建議, 交接統計
- [ ] 從未被觸發的規則 stays a separate statement, not folded into the rate. With 88
      rules and few triggered per week, folding them produces a fake low score
- [ ] The memory-search modal the friction and suggestion lists link to
      (`src/public/index.html:1476-1500`, `/api/memory/search`) comes along or is
      explicitly dropped
- [ ] Per Requirement 7, blocks with three or four rows are laid out in pairs, not full
      width, and the main column is capped
- [ ] Flip the manifest entry to `live`
- [ ] Browser check on production

## Stage 6 — 團隊用量

- [ ] Port against `/api/usage/team-stats`, `/api/usage/admin/team-overview`,
      `/api/usage/admin/team-overview/:id/sessions`
      (`src/public/index.html:2459,2460,2273`)
- [ ] Replace the heartbeat-based coverage metric. `loadCoverage`
      (`src/routes/usage/team-stats.js:66`) counts `collector_heartbeat`, so a
      collector that connects but collects nothing counts as covered. Measured
      2026-07-30: it reported 8/9 while 3 real members had no usage data at all. The
      new metric counts members with usage data, and the page names who is missing
- [ ] Member drill-down: date range, group by day / tool / model / session, usage
      distribution, recent-conversation table
- [ ] Requirement 7 throughout: missing data is never rendered as zero, and the 用量
      column is labelled 新輸入＋產出 with the cache-inclusive total on a second line.
      Cache is excluded from the headline because it is the same context re-read, and
      the two differ by roughly 250 times
- [ ] No cost column. Removed by decision; see Stage 8
- [ ] Flip the manifest entry to `live`
- [ ] Browser check on production

## Stage 7 — 週報月報

Entirely absent from the console today.

- [ ] Port against `GET /api/session/report?period=week|month&offset=`
      (`src/public/index.html:2724`). Note `/portal/reports` is **not** this page: it
      is 回報紀錄, backed by `/api/bug-reports`. That name collision caused the first
      inventory to mark 週/月報 as done
- [ ] Blocks: 新增記憶, 自動建立 Friction Issue, 自動建立 Suggestion Action,
      Top Frictions, Top Suggestions, week/month switch, three periods back
- [ ] **Fix the count query rather than porting it.** Measured 2026-07-30: the
      Suggestion Action count renders empty while the Top Suggestions list below it has
      a row. The list proves the data exists, so the count query is wrong
- [ ] Flip the manifest entry to `live`. This empties the manifest, so by Requirement 5
      the old console stops being served and starts redirecting with no further edit.
      Confirm by requesting `/admin/` rather than assuming
- [ ] Browser check on production

## Stage 8 — Clean up after the automatic retirement

`/admin/` already stopped serving when Stage 7 emptied the manifest. This stage is the
cleanup the redirect does not do by itself.

- [ ] **Prerequisite, do this first.** Add the `requiresSetup` branch to the console's
      login. `POST /api/admin/login` returns `{ requiresSetup: true }` when
      `password_hash IS NULL` (`src/routes/admin.js:51-53`) and the old console's
      `setupForm` consumes it (`src/public/index.html:159-166,1137-1152`).
      `LoginPage.jsx` has no such branch and `POST /api/me/login` hard-rejects that
      state with 401 (`src/routes/me.js:49-51`). This is the terminal step of the
      documented sole-admin recovery path (`scripts/reset-admin-password.js:9,45,164`
      and all three READMEs). Without it, retiring `/admin/` leaves a locked-out
      super_admin unrecoverable through any UI
- [ ] Update the recovery instructions in `scripts/reset-admin-password.js:164` and
      `README.md:306,328` plus the zh-TW and ja mirrors, which all say "open
      /admin/setup, NOT /setup"
- [ ] Verify on production that `/admin/` and `/admin/*` redirect, relatively
- [ ] Delete the now-unreachable `express.static(join(__dirname, 'public'))` branch
      (`src/app.js:61`), which also resolves the whole-`src/public/` exposure: today
      `/admin/setup.html`, `/admin/me/index.html` and `/admin/dashboard/index.html` all
      resolve
- [ ] Move `src/public/index.html` to a legacy name with a header comment
- [ ] Fix the three tests that read it: `tests/admin-html-no-duplicate-const.test.js:8`,
      `tests/admin-stats-memory-count.test.js:23` (it lifts and executes
      `countExportedMemories` out of the inline script),
      `tests/p3-update-event-semantics.test.js:31`
- [ ] Confirm `/setup` still resolves; it is served by an explicit route
      (`src/app.js:77-79`), not by the removed mount
- [ ] Update `Dockerfile:30-31`, which documents the blue-green strategy and names
      `legacy-admin-v1.html`
- [ ] **Backend dead code.** Delete what the retirement makes unused, and state
      explicitly what must stay for the console:
      - `/api/admin/login` and its `authLimiter` line (`src/app.js:44`): the console
        authenticates via `/api/me/login`. It also writes an `audit_logs` 'login' row
        (`src/routes/admin.js:60`) which me-login does not, so removing it ends login
        auditing. Decide whether to move that write
      - `/api/admin/iron-rules/*` (`src/routes/admin-iron-rule-upgrade.js`) with the
        鐵律升級 feature
      - `writeAdminAudit` (`src/routes/admin-iron-rule-upgrade.js:34-40`) writes to
        `admin_audit_logs`, a table **no migration creates**, so those inserts have
        always failed silently into their try/catch. Remove or fix
- [ ] **Remove the cost calculation entirely.** Vin's decision 2026-07-30: it needs a
      human to maintain every model's price, and `src/jobs/usage-aggregation.js:123`
      sets `cost_usd = null` when any model in a batch has no price, so one gap blanks
      the whole column. Delete `/api/usage/pricing` (`src/routes/usage/pricing.js`),
      `src/utils/pricing-lookup.js`, the `pickPricing` / `computeCost` calls in
      `src/jobs/usage-aggregation.js:14,101-139`, and `tests/pricing.test.js`. Leave
      the `usage_metrics_daily.cost_usd` column; dropping it needs a migration for no
      benefit. This also closes an open authorization gap: `GET /api/usage/pricing` was
      mounted with plain `auth` while only `POST` was `superAdminAuth`
      (`src/routes/usage/pricing.js:25,48`), and the old console hid the card
      client-side using the user-writable `om_role` key
- [ ] Decide `/api/usage/exemptions` (`src/routes/usage/exemptions.js`): a super_admin
      CRUD API with no UI anywhere. In scope or explicitly out
- [ ] Confirm the Requirement 5 guard did real work: check out the Stage 6 state and
      observe that `/admin/` was still served then
- [ ] Close the loop on `openspec/changes/archive/v1.20.4-legacy-retire/`
- [ ] Browser check on production

**Done when**: one console.

## Known gap, not a stage

`src/public/dashboard/` is gitignored (`.gitignore:15`); only `index.html`,
`me/index.html` and `setup.html` are tracked under `src/public/`. Today `/` redirects
to a checked-in file that always renders. After Stage 1b the root depends on a build
artefact, and after Stage 8 there is no build-independent console at all, so
`npm start` on a fresh clone serves a redirect into a 404. Decide before Stage 8
whether to track the build, add a build step to start, or serve a plain fallback.

## Deliberately out of scope

- `/setup` stays a separate unauthenticated bootstrap flow
- `/super/audit` is not built; removed from the navigation in Stage 1a
- 鐵律升級 is not ported. Confirm with Vin before deleting: the old tab reports
  `total / skill_md_format / legacy_text`, which answers whether the legacy-text
  migration ever completed. Locally all 88 synced rules carry frontmatter; the
  production number was never checked
- 資料品質警示 is not ported. Hidden since v1.17.20 as "not needed day to day"
- The five already-working pages (專案歷程, 工作交接, 個人資料, 安全性, 密鑰保管庫)
  are not redesigned

## Cross-cutting checks for every stage

- [ ] Redirects relative, never absolute (Requirement 4)
- [ ] Role gating tested at both sidebar and route level (Requirement 2)
- [ ] Missing data distinguished from zero, at the data layer (Requirement 7)
- [ ] Manifest entry flipped, and the effect on `/admin` observed (Requirement 5)
- [ ] Server and client both reviewed, per the project rule
- [ ] CHANGELOG / FILELIST / README ×3 updated in the same change
- [ ] Any test data created on production cleaned up afterwards
