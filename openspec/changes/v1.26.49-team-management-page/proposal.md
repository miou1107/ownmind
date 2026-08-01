# v1.26.49 — Build the team management page

Stage 2 of `single-console-consolidation`. The first legacy `/admin/` feature
that gets **rebuilt** rather than signposted. When this ships, the amber dot
next to 「成員」 in the console sidebar disappears — admin no longer needs to
cross into the old console to add a user, reset a password, or delete an account.

## What changes for the user

`/admin/team` stops being a signpost and starts being a real page. Every action
the legacy `/admin/` "使用者管理" tab supports is present, plus one column and one
per-row action that the old UI lacked:

- **用量資料 (近 7 天)** column — the only place in the whole console where every
  team member is reviewed one by one. Missing data is marked as "尚無資料" rather
  than rendered as zero (umbrella spec Requirement 7).
- **複製安裝指令** per-row action — the legacy tab hides this behind a separate
  collapsible section with its own picker. Moving it into the row that already
  owns the user's API key removes the second selection step. The prompt content
  is unchanged.

Every other action maps 1:1 to the legacy UI.

## Scope of the users list

Six columns. First four come from `GET /api/admin/users`, fifth is a boolean on
the same row, sixth is a per-user roll-up from `GET /api/usage/team-stats`.

| Column | Source | Notes |
|---|---|---|
| Email · 姓名 | `email`, `name` | Two-line cell; `name` may be empty |
| API Key | `api_key` | Truncated to first 8 chars + copy icon; full key never rendered |
| 角色 | `role` | Badge; `super_admin` uses purple, `admin` blue, `user` neutral |
| 密碼狀態 | `must_change_password` | 待改 (amber) / 已改 (green). Not surfaced in legacy UI |
| 用量資料（近 7 天） | `/api/usage/team-stats users[]` | tokens + session count; "尚無資料" italic if the user has no rows in `token_usage_daily` for the period |
| 操作 | dropdown | Four items (see below) |

**Single-admin warning banner** ports from legacy: shown when
`admin + super_admin ≤ 1`, amber. Purpose: nudge a lonely super_admin to name a
backup before their credentials become the whole team's failure mode.

## Row actions (dropdown)

Vin's call on the four items, 2026-07-31:

1. **複製安裝指令** — new. Uses the user's `api_key` + the current
   `getApiUrl()` (strips `/admin(/.*)?$` from `location.origin`). Emits the same
   `install.sh` / `install.ps1` prompt string the legacy tab emits; single-click
   copy to clipboard, toast confirmation. No modal.
2. **修改角色 · 名字** — new. Calls `PUT /api/admin/users/:id`. The legacy UI
   never surfaced this endpoint despite it being fully implemented; today the
   only way to change a role or a display name is to delete the user and
   re-create. Modal has three fields (email read-only for now, name, role
   select). Role change requires super_admin per server rule
   (`src/routes/admin.js:238-245`).
3. **修改密碼** — ports legacy. Calls `POST /api/admin/users/:id/password`.
   - Self: requires `oldPassword` + `newPassword`.
   - super_admin resetting others: no `oldPassword` field shown.
   - **Deliberate non-goal**: the `POST .../reset-password` emergency endpoint
     (server-generated one-shot temp password with forced-change) stays wired
     but not surfaced in the UI. Vin's call: 「admin 自己輸新密碼」is what the
     workflow expects today; keeping behaviour parity beats introducing a new
     security flow in this stage.
4. **刪除使用者** — ports legacy. Calls `DELETE /api/admin/users/:id`.
   super_admin only, cannot self-delete, cannot delete `id=1`. Red text,
   separator above (IR-013).

## Add user

Legacy "+ 新增使用者" button ports as-is. Modal calls `POST /api/admin/users`.
When adding a `user` role with no password, the server auto-generates a random
password and returns it as `default_password` once — the console renders this
in a copyable one-shot panel instead of the legacy `alert()`. The one-time
nature is server-side; the UI just presents it more cleanly than a browser
alert.

Role picker shows `user` and `admin` for an admin actor; `super_admin` is
gated (only shown for a super_admin actor; the class is `.super-admin-only`
in legacy, done via `RequireRole`-style conditional here).

## What's NOT built this stage

- The emergency `reset-password` endpoint stays unsurfaced (Vin's call above).
- `PUT /api/admin/users/:id`'s email change: legacy never exposed this, and the
  server allows it. Leaving the email field read-only in the modal keeps the
  blast radius contained to name + role for now.
- The two summary cards from legacy (使用者總數, 我的記憶啟用中): the count is
  obvious from the list; the memory card measures the current admin's own
  memories, not team data, and belongs on the personal analytics page. Both
  dropped.
- `/api/admin/users` returns `created_at` / `updated_at`; the mockup doesn't
  show them. If Vin wants an audit-hover UI later, the API already carries the
  data — non-blocking.

## Non-goals

- No new backend endpoint. Explicit umbrella-spec requirement.
- No touching `/admin/` or any other legacy tab. Only `team-management` in
  `shared/legacy-console-manifest.js` flips from `signpost` → `live`. Five
  other signposts still keep `/admin/` served.
- No test-data cleanup automation — the e2e suite from v1.26.46 uses a
  throwaway pgvector container and is already isolated.

## Approach

- **Page layout**: single React component `client/src/pages/Admin/TeamPage.jsx`
  following the pattern of `client/src/pages/Portal/UsagePage.jsx` — hook-based
  state, `apiGet` from `../../api`, `useT()` for i18n, effect-driven data
  fetch, `useMemo` for derived data.
- **Data merge**: two `apiGet` calls, both fired in parallel via
  `Promise.all`. Merge on `user.id`. `/api/usage/team-stats` returns `users:
  [{ user:{id,name,email}, totals:{...} }]`; users without a row are marked
  unmeasured, not zero.
- **Modals**: four discrete components in `client/src/pages/Admin/`, each with
  its own state. No shared modal container — keeps each modal's failure mode
  independent.
- **Copy install prompt**: `navigator.clipboard.writeText(...)`. The API URL
  derived the same way the legacy `getApiUrl()` derives it: `location.origin`
  minus `/admin(/.*)?$`, plus `/ownmind` fallback if origin doesn't carry it.
- **Manifest flip**: `shared/legacy-console-manifest.js:52` — `state:
  'signpost'` → `state: 'live'`. The console's `App.jsx` reads `isSignpost()`
  at render time, so no code change is needed elsewhere; the sidebar's amber
  dot disappears automatically. `/admin/` stays served because five other
  entries are still signposts.

## Testing

- **Page-level test**: renders four users from a mocked `apiGet`, asserts each
  column, asserts the "尚無資料" italic marker fires for the user with no
  `team-stats` row.
- **Manifest test** (updates existing `tests/legacy-console-manifest.test.js`):
  `team-management` state is `live`; `isSignpost('/admin/team')` returns
  false.
- **App-routing test**: with the manifest at `live`, `/admin/team` renders the
  page component rather than `<Signpost>` or `<MissingPage>`.
- **e2e** (`tests/e2e/console.spec.mjs`): an admin sees the amber dot gone; a
  user role does NOT see the 成員 nav item at all (per existing role-gate
  test); the "複製安裝指令" copies a string that starts with `幫我安裝 OwnMind`.

## Known limitation

`token_usage_daily` records usage per calendar day in Asia/Taipei. The 7-day
window is computed client-side by requesting `/api/usage/team-stats?window=7d`.
The server route rounds down to daily boundaries, so a user who last used
OwnMind at 23:59 today counts for today, and one who used it at 00:01
tomorrow does not — same behaviour as everywhere else in the console.

## Filed, not fixed here

- The emergency `reset-password` endpoint has no UI. Recorded in tasks.md as a
  followup for a future security-focused stage.
- `usage_metrics_daily` is referenced in `openspec/changes/single-console-consolidation/spec.md`
  but does not exist — the actual table is `token_usage_daily`. Umbrella spec
  will get corrected as part of the stage-close docs, not here.
