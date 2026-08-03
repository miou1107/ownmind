# v1.26.50 — Spec

## Requirement 1 — Two manifest entries flip from signpost to live

`shared/legacy-console-manifest.js` has `system-config` at `state: 'live'`
AND `broadcast` at `state: 'live'`. `isSignpost('/system/config')` and
`isSignpost('/system/broadcast')` both return false. Five other entries
remain `signpost`, so `isLegacyConsoleRetired()` still returns false and
`/admin/` is still served by the legacy static mount.

### Scenario: admin visits the console after Stage 3 ships

- **GIVEN** the manifest has `system-config` and `broadcast` at `state: 'live'`
- **WHEN** an admin navigates to `/dashboard/system/config`
- **THEN** the page renders `<SystemConfigPage>`, not `<Signpost>`
- **AND** the sidebar's amber dot next to 系統設定 is absent
- **AND** the sidebar's amber dot next to 廣播管理 is absent for super_admin

### Scenario: legacy console still serves

- **GIVEN** five signposts remain (bug-reports, work-log, stats-dashboard,
  team-usage, periodic-reports)
- **WHEN** a request hits `/admin/`
- **THEN** the response is 200 with the legacy `index.html`, not a redirect

## Requirement 2 — 系統設定 page shows the banner and the table

`/system/config` renders in this order:

1. Page title `系統設定` + subtitle explaining what's on the page.
2. **A banner surfacing three counts**: 正常運作 / collector 靜默 / 未裝. When
   the silent count is > 0, the banner names the silent users by name.
3. The 裝機狀況 table, one row per user, columns: User, Email, Role, 整體狀態,
   各工具版本 / 最後 heartbeat.

The page reads `/api/usage/admin/clients` and `/api/usage/team-stats` in
parallel; joins on user id client-side. The window for "usage in the period"
defaults to the last 7 days ending today (Asia/Taipei).

### Scenario: user with heartbeat but no token usage

- **GIVEN** a user has one row in `collector_heartbeat` with a fresh
  `last_reported_at`
- **AND** the user has zero rows in `token_usage_daily` for the observation
  window
- **THEN** the banner's 「collector 靜默」 count includes this user
- **AND** the banner lists them by name
- **AND** the row in the table below shows 🟢 Active in 整體狀態 (that column
  reflects heartbeat health, unchanged from legacy)

### Scenario: user with heartbeat and usage

- **GIVEN** a user has heartbeat and at least one usage row in the window
- **THEN** the banner's 「正常運作」 count includes this user
- **AND** the banner does not name them

### Scenario: user without heartbeat

- **GIVEN** a user has no `collector_heartbeat` row for any tool
- **THEN** the banner's 「未裝」 count includes this user
- **AND** the row in the table below shows ⚪ 未裝

## Requirement 3 — 廣播管理 page renders the list and the create modal

`/system/broadcast` renders:

1. Page title `廣播管理` + subtitle.
2. A "+ 新增廣播" button at top-right.
3. The full broadcast list from `GET /api/broadcast/admin?include_ended=true`,
   newest first, up to 200 rows.

Row columns match the legacy card: 建立時間, Type badge (+ auto badge if
`is_auto`), Severity, 標題, 生效區間, Snooze, 操作.

### Scenario: super_admin views the list with mixed rows

- **GIVEN** `GET /api/broadcast/admin?include_ended=true` returns three rows:
  one active manual, one active auto, one ended manual
- **THEN** the active manual row has a 撤銷 button in the 操作 column
- **AND** the active auto row shows `(auto-managed)` in place of the button
- **AND** the ended manual row renders at 45% opacity with no button

### Scenario: super_admin creates a broadcast

- **GIVEN** the actor clicks "+ 新增廣播"
- **AND** fills type = `announcement`, severity = `info`, title = `test`,
  body = `hello`
- **WHEN** the actor clicks 發布
- **THEN** the client calls `POST /api/broadcast/admin` with the form payload
- **AND** on 201 response, closes the modal, refreshes the list, shows a
  toast confirming
- **AND** the new row appears at the top of the list

### Scenario: super_admin revokes an active manual broadcast

- **GIVEN** a row is active and `is_auto = false`
- **WHEN** the actor clicks 撤銷 and confirms
- **THEN** the client calls `DELETE /api/broadcast/admin/:id`
- **AND** on 200 response, refreshes the list, shows a toast

## Requirement 4 — Roles gated at sidebar and route

`/system/config` and `/system/broadcast` register in `client/src/App.jsx`
inside a `RequireRole` gate that matches the `minRole` declared for their
paths in `nav-sections.js`:

- `/system/config` → `admin` at both places.
- `/system/broadcast` → `super_admin` at both places.

### Scenario: a user role hits either path directly

- **GIVEN** the actor's role is `user`
- **WHEN** a request to `/system/config` or `/system/broadcast` is made
- **THEN** `RequireRole` redirects them to `/portal/usage`
- **AND** the sidebar does not list either item for them

### Scenario: an admin hits the broadcast page directly

- **GIVEN** the actor's role is `admin` (not super_admin)
- **WHEN** the request to `/system/broadcast` is made
- **THEN** `RequireRole` redirects them (per its usual "role too low" branch)
- **AND** the sidebar does not list 廣播管理 for them

## Requirement 5 — Auto-managed broadcasts cannot be revoked

The 撤銷 button is only rendered when the row satisfies BOTH:

- `is_auto === false`
- Effective now (ends_at IS NULL OR ends_at > now)

An `is_auto` row shows the string `(auto-managed)` in muted text where the
button would be. This matches the server-side guard at
`src/routes/broadcast.js:165-169`.

### Scenario: attempt to revoke an auto broadcast via UI

- **GIVEN** the row's `is_auto` is true
- **THEN** the 撤銷 button is not rendered
- **AND** the row shows the `(auto-managed)` label

## Requirement 6 — Missing data marked, not shown as zero

The 系統設定 page's banner distinguishes:

- users with heartbeat AND usage (`flowing`)
- users with heartbeat AND zero usage (`silent`)
- users with no heartbeat (`not_installed`)

The silent category is a positive statement of "installed but data pipe
returning nothing", not a zero on the tokens column. This is umbrella spec
Requirement 7 applied to this stage.

### Scenario: banner never renders "0 tokens" for silent users

- **GIVEN** a user has heartbeat and zero usage rows
- **WHEN** the banner renders that user's name in the silent list
- **THEN** the banner phrase does not use the character `0` next to their name

## Requirement 7 — Broadcast payload validates before submit

The client re-uses the server's `validateBroadcastPayload` shape:

- `title` is required and ≤ 200 chars.
- `body` is required and ≤ 2000 chars.
- `snooze_hours` (when `allow_snooze` is on) is a positive number.
- `cooldown_minutes` is 0 or a positive number.
- `ends_at` (when set) parses as a valid date.

Invalid submit is refused client-side with an inline error; no request is
made. Server enforces the same set again for defence in depth.

### Scenario: title left blank

- **GIVEN** the actor leaves 標題 empty and clicks 發布
- **THEN** the modal shows an error, no POST is fired
