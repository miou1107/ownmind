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
- [x] Browser check on production — **done 2026-08-05**, sixteen months of "next SSH
      session" closed. Full CRUD driven through the UI against production: created a
      marked test account, renamed it, deleted it, back to nine rows, and the account
      confirmed gone from the database afterwards. Exactly three writes, all mine, all
      cleaned up. Two things confirmed on a genuinely fresh row that fixtures cannot show:
      its 用量資料 reads 尚無資料 rather than "0 tokens" (the v1.26.56 correction to this
      stage's own Requirement 7 fix), and its 密碼狀態 reads 待改. The delete confirmation
      names the account, says it cannot be undone and that the memories go too, and its
      button is red while cancel is not. **Password reset was not tested because it was
      never built** — Vin's scope decision recorded above, so the row menu has three items
      and none of them is a password action

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
- [x] Browser check on production — **系統設定 done 2026-08-05**, and it is doing the job
      the stage was written for. On real data it reads: 「2 位近 7 天沒任何 token 使用紀錄，
      但 collector 都還在跟 server 打卡：Adam、Amiee Kuo。這是舊版「已裝」數字沒有告訴你的
      死角」— the silent state named, counted, and the people listed. It independently
      corroborates what OwnMind memory 740 recorded about Adam. No pricing card anywhere on
      the page, confirming v1.26.60's removal reached the UI
- [ ] **廣播管理 create/revoke still untested, deliberately.** The page renders its 43
      existing broadcasts cleanly, but creating one puts a message in front of every
      member's AI session. That is outward-facing, so it is Vin's call rather than
      something to run as a test

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
- [x] Browser check on production — **done 2026-08-05, using real work rather than test
      data.** 錯誤回報 lists six reports with both sub-tabs; the detail modal for Eric's #9
      opened, and its status was moved `new` → `fixed` through the UI, which is true as of
      the release deployed the same day. One PATCH, no test rows created. 工作紀錄 renders
      100 rows across its four filters. **Found while there**: the bug-report detail modal
      is a fixed overlay with no `role="dialog"`, so it is not announced as a dialog —
      minor, filed rather than fixed here

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

Shipped as `v1.26.58`.

- [x] Ported against `/api/usage/team-stats`, `/api/usage/admin/team-overview`,
      `/api/usage/admin/team-overview/:id/sessions`
      (`src/public/index.html:2459,2460,2273`)
- [x] Heartbeat-based coverage replaced. `loadCoverage` counted
      `collector_heartbeat`, so a collector that connects but collects nothing
      counted as covered; measured 2026-07-30 it reported 8/9 while 3 real members
      had no usage data at all. Coverage is now derived from the same `users` array
      the table is built from, so the panel and the ranking cannot disagree, and the
      three buckets (measured / opted_out / unmeasured) partition the team so the
      denominator is honest. The panel names who is missing. Whether a collector is
      connected is a different question and stays on 系統設定
- [x] Member drill-down: its own date range (reset to the ranking's window when a
      different member is opened), group by day / tool / model / session, usage
      distribution, recent-conversation table. **Deviation from the legacy page,
      deliberate**: the conversation list is fetched with the totals rather than
      lazily behind 展開. The lazy load saved one query and cost a cache that had to
      be invalidated in three places (range change, member change, reload); the
      toggle now only shows and hides what is already there
- [x] Requirement 7 throughout: unmeasured members carry a badge, their four usage
      cells read 尚無資料 with the reason on hover, and they sort last under every
      metric rather than mixing with real zeros. Four distinct absences are named
      separately (no usage reported / no session logged / no project on the sessions
      / no rule triggered) instead of one dash. The 用量 column is 新輸入＋產出 with
      the cache-inclusive total on a second line
- [x] No cost column, and no cost anywhere on the page. Asserted by an e2e spec that
      reads the rendered text, not by reviewing the JSX. The sort options are
      用量 / 訊息數 / 活躍時長; 依成本 is gone with it. Supporting code deleted in Stage 8
- [x] `GET /api/usage/stats` gained `has_usage_data`. Its columns are all COALESCE'd,
      so "reported zeros" and "reported nothing" reached the drill-down looking
      identical: the same hole team-stats closed in v1.26.56, one endpoint over.
      `row_count` is dropped from the response rather than passed through
- [x] Manifest entry flipped signpost → live. One signpost remains
      (periodic-reports), so `/admin/` is still served — asserted, not assumed
- [x] Code review: 0 Critical, 3 Important, 2 Minor, each reproduced before acting.
      **The first Important is the v1.26.56 Critical in a new place**: clicking a
      second row while a drill-down is open reuses the component, so the heading
      switches immediately while the cards, the chart and the conversation list are
      still the previous member's. Closed structurally with `key={selected.id}`
      rather than by remembering to null four pieces of state. **The second**:
      opening a member while the range is reversed left the spinner up for ever,
      because the early return skipped `setLoading(false)` and the ranking still
      renders its last good payload, so there is a row to click. **The third**: the
      按對話 grouping ordered by `SUM(cost_usd)`, which is null for every member with
      data, so all groups tied and `LIMIT 100` kept whichever hundred the executor
      produced; it ranks by tokens now. Minors: the endpoint's own cost sort had
      decayed into sorting by user id, and an e2e assertion matched `USD` inside
      member names. Both Important UI fixes gained an e2e spec, **each verified red
      then green** — the second one's first draft was a false pass, because against
      a local server the stale window is a few milliseconds and a retrying assertion
      sails straight past it; it holds the responses open for three seconds now
- [x] Released and deployed 2026-08-04. `v1.26.58` on `/VinService/ownmind`,
      `git fetch --tags && git checkout v1.26.58 && docker compose build --no-cache api
      && docker compose up -d api`. No migrations in this range (17 applied, 0 new).
      The served asset hash `index-DnczAjdB.js` matched the local
      `build:no-translate` output, which is the same script the Dockerfile runs.
      Container up, clean startup log, `/health` 200
- [x] Post-deploy browser check, super_admin path, with a non-GET fetch and XHR guard
      installed **before** navigating; `__omBlocked` stayed empty throughout, so
      nothing on this page so much as attempted a write. `visibilityState` was
      `hidden`, so every claim below is read from the DOM rather than from a
      screenshot. **Requirement 7 is legible on real data, which is the point**:
      of 9 members, 6 reported usage and 3 did not, so the panel reads 67% and names
      Adam, Vin-windows-test and Amiee Kuo rather than only counting them. Adam has
      session logs but no usage rows, so his activity columns are populated (7
      conversations, multi-claude-switcher, 100%) while his four usage cells read
      尚無資料 — the two endpoints' absences stay separate, which is the distinction
      the legacy page collapsed. **And the converse holds**: Joanna, who has one
      tier-2 row and genuinely zero tokens, reads a real `0`, not 尚無資料. Zero bare
      `0%` nodes anywhere; no `$`, 成本 or cost column; the unmeasured rows sort last.
      The amber marker is gone from 團隊用量 and 統計儀表板 and still present on 週報月報
- [x] Drill-down checked on production for both cases: a measured member renders six
      cards (35,371,954 fresh against 10,575,089,780 cached — the ~250x gap the
      two-line layout exists for) plus a seven-day distribution and 64 conversations;
      an unmeasured member renders six 尚無資料 cards under the sentence explaining
      that this is not a zero, while still listing his 7 conversations. Switching
      between the two left nothing of the first on screen
- [x] **The 按對話 ordering fix confirmed against production**, not just a fixture:
      38 conversations come back ordered by tokens descending, 12.9M at the top.
      Before the fix every group tied at a null cost and the hundred kept was the
      executor's choice

### Found by this stage

- [x] **The legacy page could not show the current working day.** It passed
      `2026-08-04`-style bare dates to the team-overview endpoints, which parse with
      `new Date()`; a date-only string is UTC midnight by specification, which is
      08:00 in Taipei. With `to` set to today, everything logged after 8am was
      outside the window and 最近活動 never showed it. The new page sends explicit
      `+08:00` bounds (`dayBoundsIso`), so the endpoint needed no change
- [x] **The e2e suite was one spec away from failing for an unrelated reason.** It
      drives one browser through every page inside a single rate-limit window and
      crosses the 200/minute ceiling around the thirtieth spec, which surfaces as a
      login failure in whichever spec is running at that moment. `API_RATE_LIMIT_MAX`
      now overrides it; absent or unparseable keeps the shipped 200, so no deployment
      changes behaviour. The harness sets it high. Stage 7 adds more specs and would
      have hit this
- [x] **The legacy console's coverage panel was updated, not left reading undefined.**
      It is deleted in Stage 8, but it is still served until Stage 7 flips the last
      signpost, and the new response shape would have rendered `undefined` in it
- [ ] **Backlog, not this stage: nothing tells anyone a collector went quiet.** The
      panel now names who is missing, but only to whoever opens the page. Traced on
      production 2026-08-04: one member's scanner stopped uploading on 07-15 and
      nobody noticed for twenty days, because his MCP kept heartbeating daily and the
      old metric counted that as covered. The two heartbeats have different writers
      and that is the whole diagnostic: `mcp/index.js` sends `events: []` with an
      `os` field for one tool, while `hooks/ownmind-usage-scanner.js` sends five
      tools within the same second and no `os`. One row moving alone means the
      scheduled scanner is dead while the MCP is fine. A "reporting nothing for N
      days" broadcast would close the loop; see OwnMind memory 740 for the full trace
      and the per-member state

## Stage 7 — 週報月報

Shipped as `v1.26.59`. The last feature to leave, so this is also the release that
retires the legacy console.

- [x] Ported against `GET /api/session/report?period=week|month&offset=`
      (`src/public/index.html:2724`) as `/portal/periodic-reports`. Note
      `/portal/reports` is **not** this page: it is 回報紀錄, backed by
      `/api/bug-reports`. That name collision caused the first inventory to mark 週/月報
      as done
- [x] All blocks: 新增記憶, 自動建立 Friction Issue, 自動建立 Suggestion Action,
      Top Frictions, Top Suggestions, the week/month switch, three periods back, and the
      memory-search modal Stage 5 left as this stage's decision (ported — Requirement 3
      is that consolidation loses no feature, and without it the two lists become dead
      text where they are clickable today)
- [x] **The task above said "the count query is wrong". It was not wrong, it was
      absent.** `computeReportData` never emitted `suggestion_actions_created`, so the
      legacy `?? '—'` resolved to `undefined` on every request the card ever served. The
      data is real — `src/jobs/weeklyReport.js:77-86` writes those memories, mirroring
      the friction issues at `:36-45` — so the fix is the symmetric count. Both are now
      one query with `COUNT(*) FILTER`, because two cards reading "created in this
      period" drifting apart is how one of them ended up with no query at all
- [x] Also stated, not silently carried: the two created-counts count creations **in**
      the window, and the weekly job runs Monday over the *previous* week, so an issue
      distilled from last week lands in this week's number. Attributing it back needs a
      period stamp the memories do not carry, so the page says which it is
- [x] Requirement 7: the legacy 本期無 friction 資料 covered four situations. Split into
      four, using two new counts (`sessions_total`, `sessions_analyzed`), each naming the
      denominator it is drawn from. Plus a fifth the legacy page could not have known:
      the report query filters `compressed = false`, and `compressOldSessions` **deletes**
      rows older than `SESSION_RETENTION_DAYS`, so 月報 + 三期前 asks for a window whose
      detail no longer exists. The page says the lists are incomplete — including when the
      window merely straddles the cutoff, which is the dangerous case, because the
      surviving days return a partial list that looks whole
- [x] Manifest entry flipped `signpost` → `live`. The list is now empty, so
      `isLegacyConsoleRetired()` is true and `/admin` redirects with no further edit.
      Verified by requesting it, in three places: a unit test against the real manifest,
      an e2e spec, and production
- [x] The e2e signpost specs are written to skip when nothing is signposted, which is now
      every run. Added the mirror block that runs in exactly that condition, so the day
      the manifest empties is not the day three specs go quiet and nothing replaces them
- [x] Released and deployed 2026-08-05. `v1.26.59` on `/VinService/ownmind`,
      `git fetch --tags && git checkout v1.26.59 && docker compose build --no-cache api
      && docker compose up -d api`. No migrations in this range (17 applied, 0 new). The
      served asset hash `index-DrzO_yhE.js` matched the local `build:no-translate`
      output. Container up, clean startup log
- [x] Post-deploy browser check, super_admin path, with a non-GET fetch and XHR guard
      installed **before** navigating; `__omBlocked` stayed empty throughout, so nothing
      was written to production. `visibilityState` was `hidden`, so every claim is read
      from the DOM rather than from a screenshot.
      **The retirement holds, and the prefix survives it** — which is the thing worth
      checking, because relative redirects are where the last three incidents were.
      `/ownmind/admin/`, `/ownmind/admin/anything/deeper`, `/ownmind/admin` with no
      trailing slash and `/ownmind/Admin` all land on `/ownmind/dashboard/`, and so do
      `/ownmind/admin/index.html`, `/admin/setup.html`, `/admin/me/index.html` and
      `/admin/dashboard/index.html` — the four paths Stage 8 lists as the whole-`src/public/`
      exposure. None of them serves `data-tab` markup any more. `/ownmind/`,
      `/ownmind/dashboard`, `/ownmind/me` and `/ownmind/me/foo/bar` are unchanged.
      Zero amber signpost markers anywhere in a super_admin's sidebar; footer v1.26.59
- [x] **The page is right on real data.** 新增記憶 16 for the current week, and both
      created-counts read a real `0` where the legacy card read `—` on every request it
      ever served. That `0` was then checked rather than assumed: every friction and
      suggestion on production occurs exactly once, the job's threshold is three, and a
      memory search for the auto-created title prefix returns nothing — so zero is the
      measurement, not the absence of one. The response carries all six new fields
- [x] **The retention warning fired on the case it exists for**, and fired as the
      *partial* one: 月報 + 三期前 is 2026-05-01 ~ 05-31, the 90-day cutoff falls around
      05-07, so the window straddles it. That month also carries `sessions_compressed: 4`
      against `sessions_total: 463` — four real compression summaries that the
      pre-review code would have counted as live sessions. The review finding was not
      hypothetical
- [x] Memory-search modal opened from a real row, titled by list, query truncated to 30
      characters as the legacy one did, and closed by Escape

### Found by this stage — an ordering error in this plan

- [x] **Stage 8's first bullet had to happen here, not there.** It is written as a
      prerequisite ("do this first") that must precede retiring `/admin/`, but it sits in
      the stage *after* the retirement. `scripts/reset-admin-password.js` sets a
      super_admin's `password_hash` to NULL and the only UI that could finish the reset
      was the legacy console's setup form; `POST /api/me/login` answered that state with
      a flat 401 saying "contact your administrator", which for a sole super_admin names
      nobody. Shipping the flip without it would have released a known lockout. Done here
      instead: `src/utils/setup-recovery.js` decides who is offered the form, and the
      console's login page finishes the flow. **Tightened while moving it**: the legacy
      `/api/admin/login` announced `requiresSetup` to any caller, while this one requires
      both a super_admin and a configured `SETUP_TOKEN` — outside a rescue window the
      response is unchanged and says nothing about the account. Driven end to end against
      a real database, mutation-verified. The three READMEs and the script's own printed
      instructions, which all said "open /admin/setup", are corrected in the same change
- [x] **`/setup` pointed at a URL that never resolved.** On an installed system it
      redirected to `admin/login`; the legacy console is `express.static` with no file
      under `login/`, so it answered `Cannot GET /admin/login`. Stage 1b found this and
      filed it as pre-existing, and Stage 8 said the right moment to fix the target was
      when the console's login gained the `requiresSetup` branch — which is now. Retiring
      `/admin` would otherwise have converted a visible 404 into a redirect chain that
      lands correctly by accident
- [x] **Login had an account-enumeration tell**, found by the adversarial pass on this
      release. `POST /api/me/login` answered a no-password account with a different string
      from an unknown email, so probing addresses revealed which are real. Pre-existing,
      but this release rewrites that exact branch. All three rejections are one constant now
- [ ] **Backlog, not this stage: period bounds lose a microsecond.** `computePeriodRange`
      ends a period at `…59.999` and every consumer compares `created_at <= end`, while
      postgres keeps microseconds — a row at `…59.9995` falls out of both that period and
      the next. Found by the same review. Not fixed here because the function is shared
      with the weekly and monthly cron jobs, which **write** data from those bounds, so it
      deserves its own release rather than a drive-by inside a presentation change

## Stage 8 — Clean up after the automatic retirement

Shipped as `v1.26.60`. `/admin/` already stopped serving when Stage 7 emptied the
manifest; this is the cleanup the redirect does not do by itself, plus one feature
removed by decision rather than by orphaning.

Four items were marked "needs Vin". Each was measured on production 2026-08-05 **before**
asking, and two of the measurements overturned the obvious answer.

- [x] ~~**Prerequisite, do this first.** Add the `requiresSetup` branch to the console's
      login.~~ **Done in Stage 7**, because "do this first" and "the stage after the
      retirement" cannot both be true. See Stage 7's "Found by this stage"
- [x] ~~Update the recovery instructions~~ — same release, same reason
- [x] Verified on production that `/admin/` and `/admin/*` redirect, relatively — Stage 7's
      browser check, four request shapes plus the four exposed file paths
- [x] **Deleted the `express.static` branch over the whole of `src/public/`.** It was not
      installed, but it was one manifest edit away from being installed, so `signpost` is
      no longer a state the manifest accepts: the validator Stage 1a built for misspelled
      states now throws on it. That turns "put a feature back in the old console" into a
      boot failure rather than a redirect loop — a signpost would link to `/admin/#tab`,
      which redirects to the console, which renders the signpost again
- [x] `src/public/index.html` → `legacy/admin-v1.26/index.html` with a header saying it is
      served by nothing. `COPY src/ ./src/` no longer carries it into the image; a new test
      asserts no COPY reaches `legacy/` at all
- [x] Fixed the tests that read it. **Seven, not the three this list named** — four more
      only referenced it in comments, which were repointed so the provenance still resolves
- [x] The signpost UI went with the state: the page, the credential handoff into the old
      console's localStorage keys, the amber sidebar marker, and three locale groups. The
      logout clear of `om_api_key` **stays** — nothing writes those keys now, but browsers
      that used the old console still hold one, and it is a credential every `adminAuth`
      route accepts
- [x] Confirmed `/setup` still resolves; it is an explicit route, not the removed mount
- [x] `Dockerfile` comments describe what is actually there
- [x] **Backend dead code**, with the two decisions taken on production data:
      - `/api/admin/login` deleted. It held the only `audit_logs` login write, and the
        ledger flagged that removing it "ends login auditing" — **measured: zero login rows
        in sixty days.** Auditing did not end here, it ended two months ago when everyone
        moved to `/api/me/login`, which never wrote one. The write moved to
        `src/utils/audit-log.js` and is called from the endpoint people use
      - `/api/admin/iron-rules/*` **kept**, no UI (Vin's call). Measured: 72 of one user's
        109 active iron rules are still legacy free text, and every other user's are — the
        migration it reports on is nowhere near done, so deleting the only thing that can
        see that would hide it
      - `writeAdminAudit` deleted. `admin_audit_logs` is created by no migration and
        `to_regclass` returns null on production, so every insert since v1.18.0 has thrown
        into its own catch. The one call with a real purpose — which admin upgraded which
        rule — was retargeted to `audit_logs`, a table that exists
- [x] **Cost calculation removed entirely** (Requirement 8). Endpoint, lookup, tests, the
      `pickPricing`/`computeCost` calls, and `cost_usd` out of every response that still
      carried it — including the narrative payload, where a per-project dollar figure
      derived from an unmaintained price list is exactly what prose turns into a confident
      claim. The column stays; historical rows are left alone. This also closed the
      authorization gap: `GET /api/usage/pricing` was mounted with plain `auth` while only
      `POST` was `superAdminAuth`
- [x] `/api/usage/exemptions` deleted (Vin's call), table kept — 0 rows on production, no
      UI anywhere, and `team-stats.js` still reads the table for the coverage denominator
- [x] **Confirmed the Requirement 5 guard did real work**, by reading the Stage 6 state
      rather than trusting the story: at `v1.26.58` the manifest held exactly one
      `signpost` and `legacy-admin-mount.js` still contained the static branch. `/admin/`
      was genuinely served then, and the flip alone retired it
- [x] Closed the loop on `openspec/changes/archive/v1.20.4-legacy-retire/`: a header
      marking it superseded, with a table of where each of its actions actually happened.
      It was written, archived and never executed, which is why the manifest exists
- [x] Browser check on production — done 2026-08-05; see the v1.26.60 change folder

### Found by this stage

- [x] **The console's login has had no brute-force limit since v1.20.** `authLimiter` (10
      per 15 minutes) was mounted on `/api/admin/login` from the beginning; `/api/me/login`,
      which replaced it, was never added. Every login moved to an unthrottled endpoint and
      nobody noticed — `/api` alone allows 200 a minute, which is a throughput ceiling, not
      a password-guessing one. Found by deleting the old endpoint and asking what it did
- [x] **The setup wizard linked to a URL that never resolved.** `src/public/setup.html`'s
      "go to the console" button pointed at `/admin/login`, which the legacy console had no
      file for. Same defect as the `/setup` redirect target fixed in Stage 7, in the other
      half of the same flow
- [x] **A fresh clone could not start.** `src/public/dashboard/` is gitignored, and until
      Stage 8 there was always a checked-in HTML file to fall back on. `npm start` now
      builds the console when it is missing; the artefact stays out of git
- [ ] **Backlog: `unknown_model` now checks against a table nothing can populate.**
      `src/routes/usage/events.js` decides whether a model is "known" by looking it up in
      `model_pricing`, and the CRUD that maintained that table is deleted. The signal was
      always "not in the price list", which is why it already fires for nearly every model;
      it now cannot be anything else. Not changed here because it sits in the ingestion
      path, which is the most load-bearing code in the product and deserves its own release
- [ ] **Backlog: the `kpi.*` locale keys are dead.** No component reads any of them; they
      are leftovers from the v1.20 prototype. `kpi.api_cost` was removed with the cost
      feature, the rest were left rather than widening this change into a locale audit

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
