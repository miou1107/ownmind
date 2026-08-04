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
- [x] **Closed by the e2e suite added in v1.26.46**, not by a manual check. It seeds a
      `user`, an `admin` and a `super_admin` with known passwords in a throwaway database and
      asserts in a real browser that a member sees only 我的 and 偏好設定, that none of the
      seven privileged items is present, and that a typed `/dashboard/admin/team` lands back
      on `/portal/usage`. That is stronger than the one-off production check this item asked
      for: it is deterministic, repeatable, and mutation-verified (opening 廣播管理 to admin
      turns it red). The residual gap is that it runs against a local build rather than the
      deployed one, which the asset-hash match at deploy time covers separately
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
- [x] Released and deployed 2026-07-30. **This host deploys by checking out a version tag,
      detached** — `git pull` fails there because no branch upstream is configured, which is
      how the first attempt ended up rebuilding v1.26.45. Recorded in OwnMind memory 745.
      `v1.26.46` then `v1.26.47`; no migrations in either range; the served asset hash
      matched the local build byte for byte both times; `shared/` landed in the runtime
      image, so the new `COPY` works in both Dockerfile stages
- [x] Post-deploy browser check, super_admin path: five sections in the documented order,
      all seventeen items, amber markers on exactly the eight signposts. A signpost names
      the destination tab, writes `om_api_key` / `om_role` / `om_user_id` / `om_user_name`
      matching the console's own credential, and the legacy console restores the session
      with no second login and opens the named tab. 整體分析 renders all ten sections plus
      the AI notes; 踩坑紀錄 renders real rows each carrying its "怎麼處理" line; the four
      audit findings render with titles; the custom range control is present. `/admin/` still
      answers 200, so the manifest is on the serving branch. No console errors
- [x] **Found by that browser check, fixed in v1.26.47**: the prompt rule added for
      Requirement 7 made the model state "有 8 位成員從來沒有回報過任何資料" when every
      member was instrumented and six were active. The instruction meant to prevent a
      confident false statement produced one. The count is exact in the UI, so the prompt no
      longer asks prose to restate it. Also added titles for the two audit-finding types the
      code reading missed: production emits four, not two
- [ ] **Needs Vin, surfaced by the browser check**: the three members with zero events
      render as real zeros on 整體分析, which is the corrected behaviour after review's I2 —
      they are instrumented, so an in-period zero is genuine. But the usage page's own
      `team_blindspot` finding calls the same three "OwnMind 對其工作完全不可觀測". Two
      pages tell two stories about the same people. The honest resolution is probably a
      third state (instrumented, but no signal at all in the period), which neither
      Requirement 7 nor the review anticipated
- [ ] **Needs Vin**: `/portal/narrative` is open to `user`, which is faithful to `/me/`
      today and to Requirement 3's "same endpoints, unchanged", but it means a member sees
      team-wide activity ranking and every colleague's per-rule compliance counts, while
      the same class of data in the 團隊 section is admin-only. Not changed unilaterally,
      because narrowing it would remove access members have today. Requirement 3 did not
      anticipate the tension with the new section model

**Done when**: nothing about where users land has changed, and everything 1b needs is
in place. Shipping this alone is safe, which is the point of the split.

## Stage 1b — Flip the entry point, retire `/me/`

Shipped as `v1.26.48`.

- [x] Root redirect at `src/app.js:165-167` changed from the hardcoded
      `/ownmind/admin/` to a relative `dashboard/`, resolved by `relativeRedirectTarget()`.
      The utility (added in v1.26.46) is the same one legacy-admin-mount uses; same
      shape, one call site
- [x] `src/middleware/first-run-redirect.js` extended to intercept `/` too, and both
      absolute Locations (`/setup`, `/admin/login`) switched to relative via the same
      helper. Without the `/` intercept, a fresh install landing on the new root would
      bypass the wizard entirely
- [x] `/me` and `/me/*` → relative 301 to `dashboard/portal/usage`. Express 5 has no
      unnamed `/me/*` wildcard, so used `app.use('/me', ...)` middleware, the same
      shape as `legacy-admin-mount.js`. Three request depths (`/me`, `/me/`, `/me/foo`,
      `/me/foo/bar`) all compute to the same terminal URL via the helper's `../` math
- [x] The three affected tests handled: `me-trailing-slash.test.js` deleted entirely
      (its subject — the conditional trailing-slash handler — no longer exists, and
      the new file covers the new behaviour). `me-report.test.js` kept only the
      `/api/me` mount assertion; the two `src/public/me/index.html` reads dropped.
      `me-pitfalls.test.js` dropped the "HTML wires it up" `describe` block; the
      API-endpoint tests stay untouched
- [x] `src/public/me/index.html` moved to `legacy/me-v1.19/index.html` via `git mv`.
      Header comment prepended stating it is a preserved snapshot not served by any
      route. No `Dockerfile` `COPY` reaches `legacy/` — verified by reading every
      COPY line — so the runtime image no longer ships it
- [x] Structural test in `tests/stage-1b-flip-root-retire-me.test.js` asserts no
      `res.redirect(...)` call in `src/app.js` **or** `src/middleware/first-run-redirect.js`
      contains a `/ownmind` string literal. 11 new behavioural tests structured as
      resolution invariants: emit the Location, resolve against two different base URLs
      (`http://x/` and `http://x/ownmind/`), assert both resolve to the intended terminal.
      Same pattern as v1.26.44
- [x] Code review round: 1 Critical (none, actually — 3 Minor). Dockerfile:33 comment
      still said "舊 admin/ + me/ 維持不動"; `Pitfalls.jsx` vs actual `PitfallsPage.jsx`;
      tasks.md checkboxes still `[ ]` after phases were done. All three fixed.
      Full suite 2312/2312 green
- [x] Released and deployed 2026-07-31. `v1.26.48` on `/VinService/ownmind` (found this
      by grepping — `/root/.ownmind/` I hit first is an unrelated personal checkout).
      `git fetch --tags && git checkout v1.26.48 && docker compose build --no-cache api
      && docker compose up -d api`. No migrations in this range (17 applied, 0 new).
      Container came up, log shows normal startup
- [x] Post-deploy browser check on production: `/ownmind/` and `/ownmind/dashboard`
      both land on the console login. `/ownmind/me`, `/ownmind/me/foo/bar` both 301 → console
      login through the correct `../` depths (verified via `curl -sI` on the container
      + through the browser after nginx). `/ownmind/admin/` still 200 with title "OwnMind
      Admin" — Stage 1a signposts intact, manifest unchanged. No console errors on any
      route
- [x] **Found by that browser check, filed pre-existing**: `/ownmind/setup` when
      `firstRun=false` resolves to `/ownmind/admin/login` which returns Express's default
      `Cannot GET /admin/login` — the legacy admin is `express.static`, no file under
      `login/`. Confirmed same 404 on `v1.26.47` before this change: not introduced here.
      Zero practical impact today (populated DB never routes through `/setup`); Stage 8
      flips the login flow via LoginPage's `requiresSetup` branch, right stage to fix
      the target there

**Done when**: three consoles become two, the console is the default entry point, no
feature lost. ✅ Achieved 2026-07-31 with v1.26.48.

## Stage 2 — 使用者管理

First rebuild: the only feature whose absence forces a trip back to the old console.

Shipped as `v1.26.49`.

- [x] Inventoried the old `users` tab before building. Eight UI blocks captured
      including the installer-prompt generator and single-admin warning banner
      that the umbrella spec called out. Emergency reset-password endpoint
      surfaced as scope decision (Vin's call: don't wire it this stage)
- [x] Built `/admin/team` against existing endpoints. No new endpoint —
      `GET /api/admin/users` widened to include `must_change_password` (SELECT
      list only, no new route). See openspec/changes/v1.26.49-team-management-page/
- [x] Added 用量資料 column. Reads `/api/usage/team-stats`, merges on user id,
      renders italic "尚無資料" for users with no stats row (not zero). `token_usage_daily`
      is the actual source table (umbrella spec's `usage_metrics_daily` reference is stale)
- [x] Destructive delete: red text, `border-t` divider above, kept away from edit.
      RowMenu.jsx encodes it generically so a future stage adding another destructive
      action doesn't need a rewrite
- [x] Manifest entry flipped signpost → live. Only one entry changed; seven signposts
      remain; `/admin/` still served; sidebar amber dot next to 成員 disappears
- [x] Tests: three new Node --test files (28 assertions for the pure functions),
      three updated e2e tests + three added e2e tests. Full suite 2340/2340 green
- [x] Code review pass: 1 Critical (must_change_password missing from SELECT),
      3 Important (e2e amber-dot scoping wrong, umbrella tasks not ticked, PasswordModal
      onDone missing load()), all fixed. Docs count typo also fixed
- [ ] Browser check on production — deferred to next SSH session (Vin's admin
      credentials needed; can't test add/edit/delete/password flows without login)

## Stage 3 — 系統設定 + 廣播管理

Shipped as `v1.26.50`. One old tab split across two pages. The pricing block was
**not** ported; see Stage 8.

- [x] `/system/config`: 裝機狀況 plus the banner surfacing the "heartbeat yes,
      data no" state. Three states surfaced by name — flowing / silent /
      not_installed / offline — the old "已裝" count hid the silent state.
      Umbrella Requirement 7's first real application
- [x] Role decision recorded: `/system/config` at admin+ (matching the legacy
      裝機狀況 card, which has no super-admin-only class); `/system/broadcast`
      at super_admin (matching the broadcast card's own super-admin-only markup
      and the server's superAdminAuth on POST/PATCH/DELETE). Manifest and
      nav-sections both encode this from v1.26.46 onward
- [x] `/system/broadcast` against `/broadcast/admin`. Create, list, revoke.
      is_auto rows unrevocable both in the UI and server-side. Same behaviour
      as legacy card
- [x] Confirmed no fourth block hiding in the settings tab — legacy tab has
      exactly three cards (pricing, broadcast, installation-status), read
      directly off `src/public/index.html:584-653`
- [x] Both manifest entries flipped signpost → live. Five signposts remain;
      `/admin/` still served
- [x] Tests: role gating asserted via console-nav-structure; broadcast
      pure-function tests cover isRevocable / isActive / snooze label / type &
      severity classification; 系統設定 tests cover four states + null-stats
      degradation. Suite 2388/2388 green
- [ ] Browser check on production — pending SSH session (needs admin + super_admin
      logins to verify banner counts and CRUD flows)

## Stage 4 — 錯誤回報 + 工作紀錄

Shipped as `v1.26.51`. Two more legacy tabs go real: bug-reports and work-log,
the two read-only observability pages. Two amber dots vanish; three signposts
remain (stats-dashboard, team-usage, periodic-reports).

- [x] `/admin/bugs` against `src/routes/bug-reports.js`, including the
      reports / spam sub-tabs. Report list, detail-and-status modal with
      wontfix + wontfix_other branches, spam-confirm modal with red danger
      button separated from cancel per iron rule. `PATCH /:id/status` needed
      a new `apiPatch()` on the API client (mirrors `apiPut`)
- [x] Replaced the `/system/work-log` signpost with the real page against
      `GET /api/admin/work-log` and `/filters`. Six filters, three-source
      timeline (activity / compliance / session), load-more pagination
- [x] The third stat card in the legacy 錯誤回報 tab — `封鎖期內使用者` — is
      deliberately dropped. `document.getElementById('brSpamBlockedCount').textContent`
      is never set anywhere in `src/public/index.html`, no endpoint returns an
      active-block count, `bug_report_spam_blocks` is INSERT-only in the
      codebase. Requirement 7 applies: don't render a number we don't measure.
      Recorded in the proposal and the CHANGELOG
- [x] Both manifest entries flipped signpost → live. Three signposts remain;
      `/admin/` still served
- [x] Tests: four new pure-fn test files (43 assertions across
      `bug-report-row-vm`, `bug-status-update-validate`, `work-log-query`,
      `work-log-row-vm`) plus two new manifest assertions
- [ ] Browser check on production — pending SSH session (needs admin +
      super_admin logins to exercise the two modals and the CRUD roundtrip)

## Stage 5 — 統計儀表板

Shipped as `v1.26.56`. Vin uses this page and wanted it ported in full. The largest
single stage, and the only one that was a new integration rather than a move.

- [x] All eighteen blocks ported against `/api/activity/stats/all`,
      `/api/activity/stats?user_id=` and `/api/activity/stats/rules?user_id=`. The
      console had never called `/api/activity/*` before, so this was new wiring.
      `src/routes/activity.js` is untouched, per Requirement 3
- [x] Two views as today, driven by one control bar: empty user select → cross-user
      overview, a user id → that user's detail. Range 7 / 30 / 90, default 30
- [x] Blocks: 用戶活躍度總表, 記憶數量卡片, 記憶類型分布, 工具分布, 模型分布,
      每日活動量, 鐵律合規率, 各規則落地率, 各工具落地率, 每條鐵律落地率表,
      從未被觸發的規則, 鐵律觸發 Top 5, 系統健康, 常用操作, 專案分布, 使用者痛點,
      AI 改善建議, 交接統計
- [x] 從未被觸發的規則 kept as its own statement. Asserted by a test that puts two
      untriggered rules beside a 100% rule and requires the 100% to survive
- [x] **This line was wrong, and the correction is the finding**: the memory-search
      modal is not on this page. `data-search-text` appears at `src/public/index.html`
      `:2750` and `:2761`, both inside `loadReport()` — the 週/月報 tab. The stats
      tab's friction and suggestion lists render plain divs with no handler. It is
      Stage 7's decision
- [x] Requirement 7's layout rule applied, and **verified by measuring real bounding
      boxes in the browser** rather than by asserting class names. Mutation-verified
      both ways: stacking the pair, and removing the width cap, each turn it red
- [x] **Requirement 7 defect in the legacy page, fixed not carried over**: 各規則落地率
      and 各工具落地率 computed `t > 0 ? … : 0` and then banded, so a rule with no
      events in the period was painted solid red at 0%. An absence of evidence rendered
      as evidence of failure
- [x] Three more Requirement 7 gaps closed while here: 尚無數據 split into named causes
      (no compliance events / no sessions / no init events observed) instead of one
      label for four different situations; the four context blocks always render and
      state why they are empty rather than `classList.add('hidden')`; and the context
      section states its denominator
- [x] Manifest entry flipped signpost → live. Two signposts remain (team-usage,
      periodic-reports); `/admin/` still served
- [x] Code review: 1 Critical, 4 Important, 12 Minor, each reproduced before acting.
      **The Critical was an unguarded response race.** Both selects refetch on change;
      the overview is 3 queries and the detail is ~15, so the cheap one routinely lands
      first, and because the overview branch nulls `detail` while the detail branch
      nulls `overview`, a late reply from the abandoned request left the page rendering
      nothing at all — no table, no spinner, no error. The user-to-user variant showed
      one member's numbers under another member's name. Extracted to `request-gate.js`
      so the guard is executed by a test rather than being two `if` lines in JSX.
      Suite 2514 pass / 0 fail; e2e 26 pass / 0 fail; client build exit 0
- [x] Released and deployed 2026-08-04. `v1.26.56` on `/VinService/ownmind`,
      `git fetch --tags && git checkout v1.26.56 && docker compose build --no-cache api
      && docker compose up -d api`. No migrations in this range (17 applied, 0 new). The
      served asset hash `index-hiB8EIMn.js` matched the local build. Container up, clean
      startup log. The 04:30 backup cron added in v1.26.53 is still installed
- [x] Post-deploy browser check, super_admin path, with a non-GET fetch guard installed
      **before** navigating (nothing tried to write; `__omBlocked` stayed empty, so no
      production row was touched this time). Sidebar and footer read v1.26.56; the amber
      marker beside 統計儀表板 is gone while 團隊用量 and 週報月報 keep theirs; no
      console errors. **Requirement 7 is visible on real data, which is the point**: for
      an account with no compliance events, 整體落地率 reads 尚無數據 while 遵守 /
      跳過 / 違反 read a genuine 0; 各規則落地率 and 各工具落地率 say "本期沒有合規回報
      事件，所以算不出落地率"; 每條鐵律落地率 says the different and correct "這位使用者
      沒有啟用中的鐵律"; and on the busiest account the ~75 rules with `0 0 0` render
      尚無數據 where the legacy page would have painted every one of them solid red at
      0%. Zero bare `0%` nodes anywhere on the page, checked by querying the DOM
- [x] **Both out-of-scope fixes confirmed against production, not just fixtures.**
      `initRateMeasured`: three real accounts (Joanna, Amiee Kuo, Vin-windows-test) have
      `by_event: 0` and no init event, and the server reports a flawless 100% for each —
      the page now says 尚無數據. Six accounts do have init events with `by_event` at 19
      or fewer, so the guard passes them through untouched. `has_usage_data`: the same
      three read 尚無資料 on 使用者管理 where they previously read "0 tokens / 0 次對話",
      while Joanna — one session, zero tokens — correctly reads `0 tokens / 1 次對話`.
      Before the fix all four looked identical
- [x] **Found by this browser check, fixed in v1.26.57**:
      `https://kkvin.com/ownmind/dashboard` with **no trailing slash** 301s to the
      absolute `/dashboard/`, which drops the `/ownmind` prefix and lands on an unrelated
      page titled "Vin WorkSpace". Cause is `express.static`'s built-in `redirect: true`
      at `src/app.js:82`, which emits a Location derived from the mount path and knows
      nothing about nginx's `rewrite ^/ownmind/(.*)`. Same class as v1.26.44 and v1.26.48
      but inside express.static rather than app code, so `relativeRedirectTarget()` never
      reached it. Confirmed identical against the container directly, so it is not nginx.
      `src/app.js` last changed in v1.26.48, and this release touches no routing, so it
      is **not** introduced here. Not fixed inline: routing is where the last two
      incidents happened and it deserves its own release with the resolve-against-two-
      bases tests v1.26.48 established — which is what v1.26.57 is. Review of that fix
      then found the first guard was **narrower than what it shadowed**: `/Dashboard`
      still escaped, because Express mounts are case-insensitive while the comparison
      was not, and an absolute-form request line let serve-static reflect a
      client-supplied host into the Location. Both now closed; see
      `openspec/changes/v1.26.57-bare-mount-trailing-slash/`

### Found by this stage, fixed here, belonging to earlier stages

- [x] **Stage 2's headline Requirement 7 fix never worked in production.**
      `loadUsersAggregate` is `FROM users u LEFT JOIN token_usage_daily d` with
      `COALESCE(…, 0)` on every column, so a member who has never reported still comes
      back as a row of zeros and `mergeUsersWithUsage`'s `measured: false` branch was
      unreachable. The 用量資料 column rendered "0 tokens / 0 次對話" for exactly the
      members the requirement exists to protect. Server now emits `has_usage_data`
      (tier 1 rows OR a tier 2 row); `bool_or(d.id IS NOT NULL)` returns FALSE rather
      than NULL for a non-matching join — verified against postgres:16, because the
      three-valued reading is the plausible-but-wrong one. Also: that column displayed
      `message_count` under a label the three locales write as session / 次對話 / 回,
      and excluding tier 2 meant a Cursor-only member saw "0 次對話" beside their real
      session count. Reads `session_count` now
- [x] **`Init 成功率 100%` was fabricated.** `src/routes/activity.js` computes
      `(initS + initF) > 0 ? rate : 100`, so an account with no init event at all was
      reported as flawless, in green. The endpoint is out of scope, but `by_event` is
      `LIMIT 20`: below the limit nothing was truncated, so an absent `init` key is
      proof of zero. Marked unmeasured under that condition; at the limit it falls back
      to trusting the server, which is the status quo and so never worse
- [x] **Four e2e tests had been silently red since v1.26.49 / v1.26.51.** Three
      signpost specs hardcoded `/admin/bugs`, which Stage 4 made a live page; one looked
      for a nav label `成員` when `nav.members` has always read 使用者管理, so the
      locator matched nothing and every `toHaveCount(0)` passed for the wrong reason.
      Nobody saw it because e2e is not part of `npm test`. Root cause was hardcoding the
      subject, which breaks again at every stage, so it is now derived from the manifest
      — **deliberately unfiltered by role**: the first draft took the first signpost at
      `LEGACY_CONSOLE_MIN_ROLE`, which yields null the day no remaining signpost sits at
      that tier and would green-skip three specs while `/admin/` is still served, the
      same defect shape being fixed
- [ ] **Backlog, not fixed here**: three sibling pages hardcode
      `toLocaleDateString('zh-TW')` (`BroadcastPage.jsx`, `WorkLogPage.jsx`, and the
      team page). The new page derives it from the active locale like `ProfilePage`
      does; unifying the other three is a cross-cutting change that does not belong to
      this stage
- [ ] **Backlog**: `tests/console-table-overflow.test.js` does not reach the new rule
      table — its `border-slate-200…rounded-xl` filter skips the `-mx-4 overflow-x-auto`
      wrapper, and the real card class is a template literal in `charts.jsx` that the
      `<div className="` scan cannot see. The code complies today; the guard just does
      not cover it. The helper is documented as a floor, not a proof

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
