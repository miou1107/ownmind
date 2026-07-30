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

- [ ] Source identity from `POST /api/me/login`, which already returns `role`
      (`src/routes/me.js:61`). No new endpoint unless a gap is proven
- [ ] Replace `useState('super_admin')` in `client/src/App.jsx` with server-sourced
      identity; remove the `profile: { name: 'User' }` placeholder in the same block
- [ ] Implement logout: clear the stored credential, return to `/login`, replacing
      the `console.log('logout')` stub
- [ ] Decide `onOpenProfile`: two call sites with different arguments, `()` and
      `('preferences')` (`TopBar.jsx:110,120`), so this is two decisions. Implement
      or remove per YAGNI
- [ ] Resolve the role simulator at `TopBar.jsx:64-84`. It mutates `currentRole`
      client-side and is passed only for `super_admin` (`Layout.jsx:52`). Once role
      comes from the server it is either dead or actively misleading
- [ ] Add route-level role guards. `RequireAuth` and `RequireFreshPassword` check
      only whether a session exists; add the equivalent for *which* role
- [ ] Tests: a `user`-role session sees neither 管理 nor 超級管理 in the sidebar;
      a typed `/admin/team` URL does not render; identity is not a literal
- [ ] Verify against the real server with a non-super_admin account, not a mocked role

## Stage 1a — Port the missing `/me/` features, raise the signposts

Order is load-bearing: signposts must exist before `/` is flipped in 1b.

- [ ] Remove 稽核記錄 from `Sidebar.jsx`, its `'/super/audit'` entry in
      `Layout.jsx:22` `PATH_TITLE_KEYS`, and the three `nav.audit` locale keys
      (`zh.json:13`, `en.json:13`, `ja.json:13`)
- [ ] Regroup the sidebar per the prototype: 我的 / 團隊 / 偏好設定 / 管理 / 系統.
      團隊用量 moves out of 個人分析, which was never a personal view
- [ ] Turn the four remaining placeholders into signposts naming where the feature
      currently lives, plus a link across. Replaces the untrue "coming soon"
- [ ] Add 工作紀錄 nav item and route **as a signpost** in this stage. It is the one
      feature with no seat today; without one it stays invisible until Stage 4
- [ ] Signpost routes are role-guarded exactly like the real pages they stand in for,
      so a `user` cannot reach one and be handed a credential
- [ ] Build the Requirement 5 manifest: one place holding each old-console feature's
      state, read by the signpost routes, the nav items **and** the `/admin` decision
- [ ] Make `/admin` an either/or driven by the manifest: while any signpost remains,
      serve the old console statically; once none do, answer with the retirement
      redirect. Install **both** branches now with the redirect dormant, so the switch
      has no gap
- [ ] Test both directions: zero signposts means `/admin/` is not served and does
      redirect; one signpost means it is served and does not redirect
- [ ] Hand the credential across when a signpost is followed, so the old console is
      already authenticated. The three consoles use three different keys
      (`om_api_key`, `ownmind_api_key`, `ownmind.api_key`) so they never clobber each
      other, but the **value** is the same `users.api_key` row whichever endpoint
      issued it. Write it plus `om_role` / `om_user_id` / `om_user_name`. Same-origin
      only, and only after confirming the session's role qualifies
- [ ] Port narrative analysis as its own route (`/api/me/narrative` +
      `/narrative/insights`). Reproduce its 503 `no_api_key` degradation
      (`src/routes/me-narrative.js:34-40`) rather than showing a broken page
- [ ] Port 踩坑紀錄 as its own route (`/api/me/pitfalls`)
- [ ] Port the two `/me/` features the first inventory missed: `audit_findings`
      warning cards (returned by `GET /api/me/report`, `src/routes/me.js:801`,
      rendered at `src/public/me/index.html:369,757-782`) and the custom date range
      (`?start=&end=`, `src/routes/me.js:202-227`)
- [ ] Confirm section by section that the new routes cover what `/me/` rendered
- [ ] Browser check on production after deploy

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
