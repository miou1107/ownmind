# v1.26.51 — Spec

## Requirement 1 — Two manifest entries flip from signpost to live

`shared/legacy-console-manifest.js` has `bug-reports` at `state: 'live'` AND
`work-log` at `state: 'live'`. `isSignpost('/admin/bugs')` and
`isSignpost('/system/work-log')` both return false. Three other entries
remain `signpost` (stats-dashboard, team-usage, periodic-reports), so
`isLegacyConsoleRetired()` still returns false and `/admin/` is still served
by the legacy static mount.

### Scenario: admin visits the console after Stage 4 ships

- **GIVEN** the manifest has `bug-reports` and `work-log` at `state: 'live'`
- **WHEN** an admin navigates to `/dashboard/admin/bugs`
- **THEN** the page renders `<BugReportsPage>`, not `<Signpost>`
- **AND** the sidebar's amber dot next to 錯誤回報 is absent
- **AND** the sidebar's amber dot next to 工作紀錄 is absent (for super_admin)

### Scenario: legacy console still serves

- **GIVEN** three signposts remain (stats-dashboard, team-usage,
  periodic-reports)
- **WHEN** a request hits `/admin/`
- **THEN** the response is 200 with the legacy `index.html`, not a redirect

## Requirement 2 — 錯誤回報 page renders stats + list + sub-tab

`/admin/bugs` renders in this order:

1. Page title 錯誤回報 + subtitle.
2. **Two stat cards**: 未處理回報 (report count where `status = 'new'`, capped
   at 50+), 疑似 spam · 待審查 (spam-suspects with `status = 'pending'`).
3. Sub-tab strip: 回報列表 (default) / spam suspect 審查.
4. **回報列表**: status dropdown filter + report table.
5. **spam suspect**: spam-suspects table when the sub-tab is switched.

The page reads:
- `GET /api/bug-reports?scope=all&status=new&size=1` (just for the count)
- `GET /api/bug-reports?scope=all&size=50[&status=X]` (list)
- `GET /api/bug-reports/spam-suspects?status=pending` (count + list)
- `GET /api/admin/users` (for user_id → user_name lookup)

### Scenario: admin lands on the page

- **GIVEN** the actor's role is admin
- **AND** three bug reports exist with statuses new/triaged/fixed
- **AND** one spam suspect is pending
- **WHEN** the actor visits `/admin/bugs`
- **THEN** the 未處理回報 card reads `1` (only status=new counts)
- **AND** the 疑似 spam card reads `1`
- **AND** the reports table shows all three rows

### Scenario: filter to a single status

- **GIVEN** the actor is on `/admin/bugs`
- **WHEN** the actor sets status filter to `fixed`
- **THEN** the reports table calls `/api/bug-reports?scope=all&size=50&status=fixed`
- **AND** the 未處理回報 count still reads the total `new` count (independent
  of the filter, matching the legacy card)

### Scenario: switch to spam sub-tab

- **GIVEN** the actor is on `/admin/bugs` on the 回報列表 sub-tab
- **WHEN** the actor clicks the spam suspect sub-tab
- **THEN** the spam table becomes visible
- **AND** the reports table becomes hidden

## Requirement 3 — 錯誤回報 detail modal supports status editing

Clicking 查看 on a report row opens a modal showing:

- The full report record (title, description, severity, component, fingerprint,
  device_fingerprint, client_tool, created_at, related_lint_event_ids)
- `context_blob.conversation_snippets` rendered per the legacy shape: strings
  in a left-bordered block; `truncated: true` in a `<details>` disclosure;
  `truncated_messages: N` as an italic summary
- A status editor: dropdown for status + conditional reason + optional note

### Scenario: admin updates a report to fixed

- **GIVEN** the actor opens report #42 and its current status is `new`
- **WHEN** the actor changes status to `fixed` and clicks 儲存狀態
- **THEN** the client calls `PATCH /api/bug-reports/42/status` with
  `{ status: 'fixed' }`
- **AND** on 200, closes the modal, refreshes the list, shows a toast

### Scenario: admin sets a report to wontfix without picking a reason

- **GIVEN** the actor opens report #42 and changes status to `wontfix`
- **WHEN** the actor clicks 儲存狀態 with status_reason left blank
- **THEN** an inline error appears; no PATCH is fired
- **AND** the reason dropdown becomes visible so the actor can pick

### Scenario: admin sets a report to wontfix / wontfix_other with no note

- **GIVEN** the actor picks `wontfix_other` as the reason
- **WHEN** the actor clicks 儲存狀態 with the note textarea empty
- **THEN** an inline error appears; no PATCH is fired

## Requirement 4 — spam suspect modal supports confirm and dismiss

Clicking 審查 on a spam-suspect row opens a modal showing:

- Suspect user (resolved via user_id → user_name)
- Trigger rule
- Related report ids
- Optional reason textarea

The modal has two action buttons: 不是 spam · 撤銷 (secondary) and 確認 spam ·
封鎖該使用者 24 小時 (danger; red; separated from the cancel button per iron
rule about destructive controls).

### Scenario: admin confirms spam

- **WHEN** the actor clicks the danger button
- **THEN** the client calls `POST /api/bug-reports/spam-suspects/:id/confirm`
  with `{ reason: <textarea contents or null> }`
- **AND** on 200, closes the modal, refreshes the spam list

### Scenario: admin dismisses a suspect

- **WHEN** the actor clicks the secondary button
- **THEN** the client calls `POST /api/bug-reports/spam-suspects/:id/dismiss`
  (no body)
- **AND** on 200, closes the modal, refreshes the spam list

## Requirement 5 — 工作紀錄 page renders filters + timeline + load-more

`/system/work-log` renders in this order:

1. Page title 工作紀錄 + subtitle.
2. Info banner explaining activity / compliance / session sources.
3. Filter row: from + to date inputs (defaults 30d), source dropdown,
   user dropdown, tool dropdown, event_type dropdown, search input, 查詢 button.
4. Result summary line: `共 N 筆，已顯示 M 筆`.
5. Table with 6 columns: 時間 / 來源 / 使用者 / 工具 / Event / 內容.
6. `載入更多` button when `shownCount < total`.

The page reads:
- `GET /api/admin/work-log/filters` (once on mount) for the user/tool/event
  dropdowns.
- `GET /api/admin/work-log/?<filters>&limit=100&offset=0` on mount and on any
  filter change.

### Scenario: super_admin lands on the page

- **GIVEN** the actor's role is super_admin
- **WHEN** the actor visits `/system/work-log`
- **THEN** the filter dropdowns are populated from `/filters`
- **AND** the initial query uses default 30-day range and no filters
- **AND** the table shows the first up to 100 rows sorted by ts DESC

### Scenario: apply a source filter

- **GIVEN** the actor changes the source dropdown to `session`
- **AND** clicks 查詢
- **THEN** the client calls
  `/api/admin/work-log/?from=<iso>&to=<iso>&source=session&limit=100&offset=0`
- **AND** the table replaces prior rows (reset behaviour, not append)

### Scenario: load more

- **GIVEN** the current query has total=200 and shown=100
- **WHEN** the actor clicks 載入更多
- **THEN** the client calls the same query with `offset=100`
- **AND** the resulting rows are appended to the table (not replaced)
- **AND** shownCount becomes 200
- **AND** the 載入更多 button hides

### Scenario: empty details cell

- **GIVEN** a returned row has `details = {}` and `summary` null
- **THEN** the 內容 cell renders `—`, not `{}`

### Scenario: session row prefers summary

- **GIVEN** a returned row has `source = session`, `details = {some: 'thing'}`,
  and `summary = 'AI summary text'`
- **THEN** the 內容 cell renders the summary, not the JSON

## Requirement 6 — Roles gated at sidebar and route

`/admin/bugs` and `/system/work-log` register in `client/src/App.jsx` inside a
`RequireRole` gate that matches the `minRole` declared for their paths in
`nav-sections.js`:

- `/admin/bugs` → `admin` at both places.
- `/system/work-log` → `super_admin` at both places.

### Scenario: a user role hits either path directly

- **GIVEN** the actor's role is `user`
- **WHEN** a request to `/admin/bugs` or `/system/work-log` is made
- **THEN** `RequireRole` redirects them to `/portal/usage`
- **AND** the sidebar does not list either item for them

### Scenario: an admin hits work-log directly

- **GIVEN** the actor's role is `admin` (not super_admin)
- **WHEN** the request to `/system/work-log` is made
- **THEN** `RequireRole` redirects them
- **AND** the sidebar does not list 工作紀錄 for them

## Requirement 7 — Third stat card is dropped, not zeroed

The legacy card had a 封鎖期內使用者 stat card whose element was defined but
never populated (no code path sets its textContent). The rebuild does NOT
render a card for this. Requirement 7 of the umbrella spec: don't show a
number we don't measure. A zero would misrepresent state that we can't verify.

### Scenario: the card is absent from the page

- **WHEN** an admin visits `/admin/bugs`
- **THEN** no element with a "封鎖期內" or "blocked" heading is present
- **AND** no stat card counting active spam blocks is present

## Requirement 8 — Details preview truncates to 200 chars

The 工作紀錄 table's 內容 cell renders at most 200 characters. The full text
is available via the cell's `title` attribute for hover.

### Scenario: a long details payload

- **GIVEN** a returned row has `details` whose JSON representation is 350
  chars long
- **THEN** the 內容 cell renders the first 200 chars visibly
- **AND** the cell's `title` attribute contains the full 350-char text

### Scenario: a short summary is not clipped

- **GIVEN** a returned row has `summary = "20-char summary text"`
- **THEN** the 內容 cell renders the full summary (no ellipsis)
