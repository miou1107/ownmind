# v1.26.51 — Rebuild 錯誤回報 + 工作紀錄 in the console

Stage 4 of `single-console-consolidation`. Both pages are read-only observability
surfaces (bug reports also has status editing, but that's a single PATCH — no
create/delete flows). Two more `/admin/` amber dots vanish; three signposts remain
(統計儀表板, 團隊用量, 週報月報).

The lowest-risk pair to port: no new tables, no new endpoints, the APIs already
exist and are covered by tests. The work is UI translation from the legacy tab
markup at `src/public/index.html:538-582` (work-log) and `:734-867` (bug-reports).

## What changes for the user

- `/admin/bugs` becomes a real page: report list + spam-suspect sub-tab +
  detail-and-status modal + spam-confirm modal. Same three admin actions as the
  legacy card: view detail, update status, confirm/dismiss spam suspect.
- `/system/work-log` becomes a real page: 30-day merged three-source timeline
  (activity / compliance / session) with the six filters the API already
  supports and load-more pagination.
- Both amber dots in the sidebar disappear.
- The other three signposts still point at `/admin/`.

## The role split

Both are super_admin-adjacent, but at different tiers:

| Page | API middleware | Nav minRole (existing) | Rebuilt page's guard |
|---|---|---|---|
| 錯誤回報 | `auth` + `isAtLeast(admin)` at each admin action | `admin` | `admin+` |
| 工作紀錄 | `superAdminAuth` at every route in the router | `super_admin` | `super_admin` |

`nav-sections.js` already declares these (v1.26.46). This stage flips the two
manifest entries, wires the pages under `REAL_PAGES`, and leaves the role model
alone.

## What `/admin/bugs` shows

Faithful port of the legacy 錯誤回報 tab, in the console's page shape:

- Page title 錯誤回報 + subtitle.
- Two stat cards at the top:
  - 未處理回報 (`?scope=all&status=new` count, capped at 50+ like the legacy card)
  - 疑似 spam · 待審查 (spam suspects with status=pending, count)
- Sub-tab strip: 回報列表 (default) / spam suspect 審查. Same two views.
- **回報列表**: status dropdown filter + table (id / 標題 / 嚴重度 / 模組 / 狀態 /
  使用者 / 建立時間 / action). Click 查看 → modal with detail + status editor.
- **spam suspect**: table (id / 使用者 / 觸發規則 / 觸發時間 / 關聯回報數 /
  action). Click 審查 → modal → confirm or dismiss.

### One card dropped

Legacy tab has a third stat card, **封鎖期內使用者** (id `brSpamBlockedCount`).
Reading the legacy JS, this element receives its initial `-` and **never** gets
populated: no `document.getElementById('brSpamBlockedCount').textContent = ...`
anywhere in `src/public/index.html`. No endpoint returns an active-block count
either — `bug_report_spam_blocks` is INSERT-only in the codebase. The card is
a placeholder that has been silently broken since the feature shipped.

Requirement 7 says: don't render a number we don't measure. Dropping the card
in the rebuild rather than porting the "-" placeholder. Filed for later: add a
`GET /api/bug-reports/spam-blocks/active-count` endpoint if we ever need it.

### One thing the API already returns that the legacy UI ignores

The list rows carry `user_id` but no `user_name`. Legacy resolves this by
crossing against the sidebar-cached `usersData` array. New page does the same:
fetch `/api/admin/users` once and join client-side. Same pattern as `TeamPage`.

## What `/system/work-log` shows

Faithful port of the legacy 工作紀錄 tab:

- Page title 工作紀錄 + subtitle explaining the three sources.
- Filter row: 日期範圍 (default 30d), 來源 dropdown (all / activity / compliance /
  session), 使用者 dropdown, 工具 dropdown, event_type dropdown, 搜尋 input, 查詢
  button.
- Info banner explaining what activity / compliance / session mean.
- Row count line: `共 N 筆，已顯示 M 筆`.
- Table (6 cols): 時間 / 來源 badge / 使用者 / 工具 / event_type / 內容 preview.
- 「載入更多」 button when `wlOffset < total`.

The `内容` cell renders `summary || JSON.stringify(details)` truncated to 200
chars, with the full text as a title tooltip. Empty details render `—` per the
legacy code (line 2707) — not `{}`.

## Non-goals

- **No new backend endpoint.** Both pages reuse routes the legacy tab already
  calls. Same rule as v1.26.49 and v1.26.50.
- **No status-notification workflow.** `POST /:id/mark-notified` and
  `/notifications/*` are reporter-side surfaces, not admin ones. `UsagePage`
  already handles the notification bell.
- **No spam blocked-user list.** Third stat card dropped (see above); the row
  panel that would go with it is out of scope until someone asks.
- **No inline editing in the list.** Status editing goes through the detail
  modal, same as the legacy card. A row-level "quick-mark fixed" button would
  be an addition, not a port.
- **No pagination controls beyond load-more.** Legacy is load-more only for
  work-log; page-size only for bug-reports (size=50). Both preserved as-is.

## Approach

- **Page pattern**: mirror `TeamPage.jsx` and the two System pages from Stage 3.
  Hook-based state, `apiGet` / `apiPatch` / `apiPost` from `../../api`, `useT()`
  for i18n, pure functions extracted for testability.
- **Bug reports view-model**: `bugReportRowVm(row, userMap)` in
  `client/src/pages/Admin/bug-report-row-vm.js` returns
  `{ severityColor, statusColor, statusLabel, userLabel, createdAtLabel }`.
  Status update validation is `validateStatusUpdate(form)` in
  `client/src/pages/Admin/bug-status-update-validate.js` — mirrors the server
  guard at `src/routes/bug-reports.js:536-557` (wontfix requires status_reason,
  wontfix_other requires a note).
- **Work-log filter builder**: `buildWorkLogQuery(filters, offset, limit)` in
  `client/src/pages/System/work-log-query.js` — pure function returning the
  URLSearchParams. The date-to-ISO conversion (`from + 'T00:00:00.000Z'`)
  lives here so it's covered by a test.
- **Row rendering**: pure `workLogRowVm(row)` in
  `client/src/pages/System/work-log-row-vm.js` returns
  `{ sourceLabel, sourceColor, timestampLabel, userLabel, toolLabel, eventLabel,
  detailsPreview, detailsFull }` — the details truncation and empty-→-em-dash
  rule live in a testable function.
- **Modal state**: two components — `BugReportDetailModal.jsx` and
  `SpamSuspectModal.jsx`. Same shape as `RevokeConfirmDialog.jsx` from Stage 3.
- **Manifest flip**: two lines in `shared/legacy-console-manifest.js`.
  `/admin/` stays served (three signposts remain).

## Testing

- **Pure function tests**:
  - `tests/bug-report-row-vm.test.js` — severity classes, status classes,
    user-map join (including the fall-through `user#{id}` case when the user
    isn't in the fetched list), timestamp slicing.
  - `tests/bug-status-update-validate.test.js` — every branch of the server
    validation mirror: status enum, wontfix requires reason, wontfix_other
    requires note.
  - `tests/work-log-query.test.js` — every filter produces the right
    URLSearchParams key; date-to-ISO conversion is stable; offset/limit propagate.
  - `tests/work-log-row-vm.test.js` — three source colors, empty details ⇒ `—`,
    truncation to 200 chars, summary preferred over details when both present.
- **Manifest test** (updates existing `tests/legacy-console-manifest.test.js`):
  `bug-reports` and `work-log` both at `state: 'live'`; `isSignpost()` returns
  false for both console paths; `isLegacyConsoleRetired()` still returns false
  (three signposts remain).
- **Role-gate test** (existing `console-nav-structure.test.js`): the two paths'
  `minRole` matches their `RequireRole` gate — admin+ for bugs, super_admin
  for work-log.
- **e2e** (existing `console.spec.mjs`): admin sees 錯誤回報 without amber dot;
  a `user` sees neither; super_admin sees both without dots.

## Known limitation

**Work-log's own-vs-others**: the timeline endpoint is super_admin only.
The bug-reports timeline is admin+ but shows every user's report when
`scope=all`. There's no per-user drill-down page here; that's the existing
UsagePage's job. Confusing? Yes, but faithful to the legacy split. A future
stage could add a link from a bug-report row to that reporter's work-log
segment; not this one.

## Filed, not fixed here

- **The list endpoint returns user_id, not user_name.** Every admin page that
  wants a user's name has to fetch `/api/admin/users` and join client-side.
  Rebuild the SELECT with a LEFT JOIN would remove one round trip per page
  load; not done here to keep the change client-only.
- **Details rendering is a JSON.stringify preview.** Full JSON payloads are
  exposed via the tooltip and the row action expands to a detail view. Prettier
  rendering (indented JSON, key highlighting) belongs in a follow-up.
- **Work-log has no export.** CSV / JSON download would be an obvious add if
  Vin ever needs to hand a slice to Codex / Cursor / GPT-5 for analysis.
  Not now.
