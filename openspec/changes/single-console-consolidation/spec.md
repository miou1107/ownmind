# Single-console consolidation — Spec

Six requirements. Each stage in `tasks.md` satisfies a subset; the program is
complete when all six hold simultaneously.

## Requirement 1 — One console, one entry point

### Scenario: the root path lands on the new console

- **GIVEN** a deployment reachable at `https://kkvin.com/ownmind`
- **WHEN** a browser requests `/ownmind/`
- **THEN** it is redirected to the React console at `/ownmind/dashboard/`
- **AND** the redirect is relative, so the same code lands on `/dashboard/` when the
  app is reached directly at `http://localhost:3100/`

### Scenario: the retired consoles redirect rather than 404

- **GIVEN** Stages 1b and 4 have shipped, so both old consoles now redirect
- **WHEN** a bookmark requests `/ownmind/me/` or `/ownmind/admin/`
- **THEN** the response is a 301 to the new console, prefix intact
- **AND** no page of either old console is reachable

### Scenario: the first-run wizard is unaffected

- **GIVEN** the `users` table is empty
- **WHEN** any console URL is requested
- **THEN** `firstRunRedirect` still routes to `/setup`, which stays outside the
  console and outside this program's scope

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

Ported: 統計儀表板, 團隊用量, 週/月報, 使用者管理, 錯誤回報, 設定 (成本設定 +
裝機狀況), 廣播管理, 工作紀錄, and from `/me/`: narrative analysis and 踩坑紀錄.

Dropped by decision: 鐵律升級 (`/admin/`), 稽核記錄 (never built anywhere).

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
