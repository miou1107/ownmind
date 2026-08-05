# Single-console consolidation — Spec

Eight requirements. Each stage in `tasks.md` satisfies a subset; the program is
complete when all eight hold simultaneously.

## Requirement 1 — One console, one entry point

### Scenario: the root path lands on the new console

- **GIVEN** a deployment reachable at `https://kkvin.com/ownmind`
- **WHEN** a browser requests `/ownmind/`
- **THEN** it is redirected to the React console at `/ownmind/dashboard/`
- **AND** the redirect is relative, so the same code lands on `/dashboard/` when the
  app is reached directly at `http://localhost:3100/`

### Scenario: the retired consoles redirect rather than 404

- **GIVEN** Stages 1b and 7 have shipped, so both old consoles now redirect
- **WHEN** a bookmark requests `/ownmind/me/` or `/ownmind/admin/`
- **THEN** the response is a 301 to the new console, prefix intact
- **AND** no page of either old console is reachable

### Scenario: the first-run wizard stays reachable after the entry point moves

- **GIVEN** the `users` table is empty
- **WHEN** a browser requests `/ownmind/`
- **THEN** it reaches `/setup`, not the console's login page
- **AND** the redirect is relative, so the `/ownmind` prefix survives

`firstRunRedirect` does **not** satisfy this today. It intercepts only `/admin`,
`/admin/*` and `/setup` (`src/middleware/first-run-redirect.js:36`), so once `/` lands
on the console a fresh install never reaches the wizard. Its two redirects are also
absolute (`:56`, `:61`) and already drop the prefix under nginx. An earlier version of
this spec asserted the current behaviour was correct; it was not.

## Requirement 2 — The console enforces roles (Stage 0)

Today `Sidebar.jsx` filters its four sections by role, but the role is the literal
`'super_admin'` from `useState` in `App.jsx`. Enforcement must come from the server,
at both the navigation and the route level.

### Scenario: a regular member sees only their own sections

- **GIVEN** a user whose server-side role is `user`
- **WHEN** they log in to the console
- **THEN** the sidebar shows only 個人分析 and 偏好設定
- **AND** neither 管理 nor 超級管理 appears

### Scenario: a typed URL cannot bypass the sidebar

- **GIVEN** the same `user`-role session
- **WHEN** they navigate directly to `/dashboard/admin/team`
- **THEN** the console does not render the page
- **AND** they are redirected to a page their role permits

### Scenario: identity comes from the server, not from a literal

- **GIVEN** any authenticated session
- **WHEN** the console renders the layout
- **THEN** the displayed name and the role both originate from a server response
- **AND** no hardcoded role or placeholder name string remains in `App.jsx`

### Scenario: logout ends the session

- **GIVEN** an authenticated session
- **WHEN** the user activates logout
- **THEN** the stored credential is cleared and the console returns to `/login`
- **AND** logout is not a `console.log` stub

## Requirement 3 — Consolidation loses no feature

The old inventory is the contract. A feature may be **ported** or **explicitly
dropped by decision**, never lost by omission.

Ported: 統計儀表板, 團隊用量, 週/月報, 使用者管理, 錯誤回報, 設定 (裝機狀況),
廣播管理, 工作紀錄, and from `/me/`: narrative analysis, 踩坑紀錄, `audit_findings`
warning cards, and the custom date range.

Dropped by decision: 鐵律升級, 資料品質警示, 稽核記錄 (never built anywhere), and the
cost calculation (Requirement 8).

**An earlier version of this spec marked 統計儀表板, 團隊用量 and 週/月報 as already
done. That was wrong.** The console calls none of `/api/activity/*`, `/api/usage/*` or
`/api/session/*`; its full endpoint list is `/api/me/login`, `/api/me/profile`,
`/api/me/change-password`, `/api/me/report`, `/api/bug-reports`,
`/api/handoff/pending`, `/api/handoff/:id/accept`, `/api/memory/type/project`,
`/api/secret` and `/api/version`. `/portal/reports` is 回報紀錄 backed by
`/api/bug-reports`, not the weekly report; the shared `nav.reports` label is what
caused the error. All three are rebuilds, in Stages 5 to 7.

### Scenario: narrative analysis and pitfalls survive the /me/ retirement

- **GIVEN** `/me/` serves narrative analysis from `/api/me/narrative` and
  `/api/me/narrative/insights`, and 踩坑紀錄 from `/api/me/pitfalls`
- **WHEN** `/me/` is redirected to the new console
- **THEN** both features are already reachable in the new console
- **AND** they are served by the same endpoints, unchanged

### Scenario: the usage page keeps its single-fetch design

- **GIVEN** `/portal/usage` fetches `GET /api/me/report?range=` once and switches
  tabs without refetching
- **WHEN** narrative analysis and 踩坑紀錄 are added to the console
- **THEN** they are separate routes, not extra tabs on the usage page
- **AND** the usage page's fetch behaviour is unchanged

### Scenario: retiring /me/ requires no credential migration

- **GIVEN** `/me/` authenticates via `POST /api/me/login`
- **WHEN** a regular member is redirected to the new console
- **THEN** their existing password works, because the console posts to the same
  endpoint

## Requirement 4 — Redirects survive the reverse-proxy prefix

nginx strips `/ownmind` before proxying, so Express cannot know the public prefix.
Every redirect introduced by this program must be relative.

### Scenario: a redirect under the proxy prefix keeps the prefix

- **GIVEN** nginx exposes the app at `/ownmind` and strips that prefix
- **WHEN** a browser requests `/ownmind/admin/`
- **THEN** the `Location` header is relative
- **AND** the browser resolves it to `/ownmind/dashboard/`, not `/dashboard/`

### Scenario: the same redirect is correct with no prefix

- **GIVEN** the app is reached directly at `http://localhost:3100`
- **WHEN** a browser requests `/admin/`
- **THEN** the same relative `Location` resolves to `/dashboard/`

### Scenario: the existing absolute root redirect is removed

- **GIVEN** `src/app.js:155` currently responds to `/` with a hardcoded
  `/ownmind/admin/`
- **WHEN** Stage 1b ships
- **THEN** no redirect target in `src/app.js` contains a hardcoded `/ownmind`
  segment

## Requirement 5 — Retirement is a consequence of finishing, not a task to remember

`v1.20.4-legacy-retire` was archived unexecuted. A checklist item cannot be the
guard, and neither can a test that merely turns red: this repo has no CI, so a red
suite blocks no release, and a deliberately-red test at release time invites being
commented out. Adversarial review raised exactly this, and it is correct.

So the guard is structural. **One manifest records each old-console feature's state
(`signpost` or `live`). The same manifest decides whether the `/admin` mount is
registered.** Retirement then happens by finishing the work, not by remembering to.

The invariant: **the console cannot be simultaneously finished and unretired.**

### Scenario: the manifest is the only source of feature state

- **GIVEN** the console renders signposts for features still living in `/admin/`
- **WHEN** a feature's state is read, whether to build a route, a nav item, or the
  `/admin` mount decision
- **THEN** every reader derives it from the one manifest
- **AND** no route, nav item or mount hardcodes that state independently

### Scenario: the last signpost flipping retires the old console automatically

- **GIVEN** exactly one feature remains marked `signpost`
- **WHEN** that entry is changed to `live`
- **THEN** the `/admin` static mount is no longer registered, with no other edit
- **AND** `/admin/` answers with the retirement redirect instead

Both branches are installed together, with the redirect dormant while signposts
remain. Adding the redirect only at the final retirement step would leave `/admin/`
404ing in the window between the last page landing and that step.

### Scenario: the derivation cannot silently drift back

- **GIVEN** the `/admin` behaviour is derived from the manifest
- **WHEN** the suite runs
- **THEN** an app built from a manifest with zero signposts does not serve `/admin/`
  and does redirect it
- **AND** an app built from a manifest with one signpost does serve it and does not
  redirect it

Both directions are required. A test that only checks the empty-manifest case passes
just as well against code that never serves `/admin/` at all, which would prove
nothing.

### Scenario: no nav item promises a feature that exists nowhere

- **GIVEN** 稽核記錄 was a nav item for a feature with no page and no API, anywhere
- **WHEN** the suite runs
- **THEN** a test asserts every nav item resolves either to a real feature page or to
  a signpost naming where that feature currently lives
- **AND** a nav item that resolves to neither fails the suite

A signpost satisfies this requirement: it is an implemented route that tells the
truth about where the feature is. "Coming soon" for a feature nobody is building
does not.

## Requirement 6 — Retired sources are preserved and unreachable

### Scenario: the old sources are kept as snapshots

- **GIVEN** `/admin/` and `/me/` are retired
- **THEN** `src/public/index.html` and `src/public/me/` are preserved under a legacy
  name with a header comment recording what they were and when they were retired

### Scenario: preserved sources are not served

- **GIVEN** `app.use('/admin', express.static(join(__dirname, 'public')))` currently
  exposes the whole `src/public/` tree, so the same files answer at several URLs
- **WHEN** Stage 5 removes that mount
- **THEN** no preserved legacy file is reachable over HTTP
- **AND** `/setup` still resolves, because it is served by an explicit route rather
  than by that static mount

### Scenario: the container still builds

- **GIVEN** legacy files have moved
- **WHEN** the image is built
- **THEN** `Dockerfile` COPY directives match the new layout and the console still
  serves, per the iron rule on synchronising read paths with the Dockerfile

## Requirement 7 — "No data" and "zero" are different values, and the difference is carried by the data, not the CSS

Measured on production 2026-07-30: three of eight real members had no usage data at
all, and the table rendered them as `0` tokens, `0` messages, `0.00h` and `$0.0000`.
That reads as "these people barely use it" when the truth is "we have no data for
them", and it is the concrete form of Vin's complaint that the presentation is wrong.

The rule lives at the data layer because the table is not the only consumer. The
narrative page is LLM-generated from `collectSections()`
(`src/routes/me-narrative.js:21,43`); given an unmarked zero it will write "Adam
hardly uses OwnMind" as a plain, confident sentence. Prose is worse than a table
here: a blank cell invites suspicion, a sentence settles the question.

### Scenario: a member with no usage data is not rendered as zero

- **GIVEN** a member whose `usage_metrics_daily` rows are absent for the period
- **WHEN** any page shows that member
- **THEN** the affected cells read as absent, distinctly from a real zero
- **AND** the row is visually marked so it is not compared against rows that have data

### Scenario: a real zero still reads as zero

- **GIVEN** a member with usage data whose value for a metric is genuinely zero
- **THEN** it renders as `0`, not as absent

### Scenario: aggregates state their denominator

- **GIVEN** a team total computed over members with data
- **THEN** the page states how many of how many members it covers
- **AND** the total is not presented as the whole team's figure

### Scenario: the narrative generator receives the gap

- **GIVEN** members with no usage data in the period
- **WHEN** `collectSections()` builds the payload for the LLM
- **THEN** the payload marks those members as unmeasured
- **AND** the generated text states that the ranking is incomplete rather than
  inferring low usage

### Scenario: a metric that cannot be computed says why

- **GIVEN** a value the server could not produce
- **THEN** the cell names the reason in the user's words and points at where to fix it
- **AND** it is not rendered as an unexplained dash

### Scenario: charts are sized to their content

- **GIVEN** a bar chart with three or four rows
- **THEN** it is laid out beside a sibling rather than spanning the full width
- **AND** the main column is capped, so a two-digit number is never placed 1500px from
  its label

## Requirement 8 — The cost calculation is removed, not fixed

Vin's decision, 2026-07-30: pricing has to be maintained by hand for every model, and
`src/jobs/usage-aggregation.js:123` sets `cost_usd = null` when any model in a batch
lacks a price, so a single gap blanks the column for everyone. Measured the same day:
all five members with usage data showed no cost, while the four with no data showed
`$0.0000`. The feature's one stated purpose was judging whether the team subscription
is worthwhile, and it served that for nobody.

### Scenario: no cost is displayed anywhere

- **WHEN** any console page renders usage
- **THEN** no cost column, tile or total appears

### Scenario: the supporting code is gone, not orphaned

- **THEN** `src/routes/usage/pricing.js`, `src/utils/pricing-lookup.js`, the
  `pickPricing` / `computeCost` calls in `src/jobs/usage-aggregation.js` and
  `tests/pricing.test.js` are removed
- **AND** the `usage_metrics_daily.cost_usd` column is left in place, because dropping
  it needs a migration and buys nothing

### Scenario: removing it closes an authorization gap

- **GIVEN** `GET /api/usage/pricing` was mounted with plain `auth` while only `POST`
  was `superAdminAuth` (`src/routes/usage/pricing.js:25,48`)
- **AND** the old console hid the card client-side via the user-writable `om_role` key
- **WHEN** the router is deleted
- **THEN** the gap is closed by removal, and no separate fix is needed
