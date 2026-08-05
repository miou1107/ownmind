# v1.26.49 — Spec

## Requirement 1 — `/admin/team` renders a real page, not a signpost

`shared/legacy-console-manifest.js` has `team-management` at `state: 'live'`.
`isSignpost('/admin/team')` returns false. `client/src/App.jsx`'s
`REAL_PAGES['/admin/team']` resolves to a component that mounts and reads real
data, not `<Signpost>` and not `<MissingPage>`.

### Scenario: admin visits the console

- **GIVEN** the console is served and manifest is at `state: 'live'` for
  `team-management`
- **WHEN** an `admin` or `super_admin` navigates to `/dashboard/admin/team`
- **THEN** the page renders a `<TeamPage>` component, not `<Signpost>`

### Scenario: sidebar still shows five amber dots

- **GIVEN** the other five signpost entries remain unchanged
- **WHEN** the sidebar renders
- **THEN** `成員` no longer carries the amber dot; the five other legacy items
  still do; `/admin/` is still served by the legacy static mount

## Requirement 2 — Users list shows six columns, one row per user

For each row returned by `GET /api/admin/users`, the page renders exactly six
columns in this order: Email·姓名, API Key (first 8 chars + copy), 角色 (badge),
密碼狀態, 用量資料（近 7 天）, 操作 (dropdown).

### Scenario: user with usage data

- **GIVEN** `/api/admin/users` returns `{ id, email, name, api_key, role,
  must_change_password: false, ... }` for a user
- **AND** `/api/usage/team-stats` returns a row for that user with
  `totals.input_tokens + totals.output_tokens = 42_300` and
  `totals.message_count = 18`
- **THEN** the row shows the email + name stacked, `sk-...` truncated api key
  with a copy button, a purple/blue/neutral badge matching the role,
  a green "已改" pill, and "42,300 tokens" over "18 次對話"

### Scenario: user with no usage rows

- **GIVEN** `/api/usage/team-stats` has no matching row for a user id (they
  never reported usage in the window)
- **THEN** the 用量資料 cell renders the italic phrase "尚無資料", styled with
  `--text-muted`, not the number `0`

### Scenario: user with default password

- **GIVEN** `/api/admin/users` returns `must_change_password: true` for a user
- **THEN** the 密碼狀態 column renders an amber "待改" pill; no other column
  changes

## Requirement 3 — Single-admin banner appears when appropriate

The amber "只有一位管理者" banner renders above the users table when
`admin.length + super_admin.length ≤ 1` across the fetched user list, and
never otherwise.

### Scenario: exactly one super_admin, no admins

- **GIVEN** the list contains one super_admin and any number of `user` roles
- **THEN** the banner is present

### Scenario: two admins present

- **GIVEN** the list contains at least two rows with `role IN ('admin',
  'super_admin')`
- **THEN** the banner is absent

## Requirement 4 — Row dropdown exposes four actions

Every row's dropdown has exactly four items in this order:

1. 複製安裝指令
2. 修改角色 · 名字
3. 修改密碼
4. 刪除使用者

Items 3 and 4 are conditionally rendered per the server's own rules:

- 修改密碼: shown when the actor is the row's user (self) OR the actor is
  super_admin AND the row's role is not `user`
- 刪除使用者: shown when the actor is super_admin AND the row is not self AND
  `id != 1`

Item 4 (destructive) is red text with a divider above it (IR-013).

### Scenario: super_admin views a row for another admin

- **THEN** all four items are visible

### Scenario: admin views their own row

- **THEN** items 1, 2, 3 are visible; item 4 is not (self-delete blocked)

### Scenario: admin views a row for a super_admin

- **THEN** items 1, 2 are visible; items 3, 4 are not (server rejects both)

## Requirement 5 — 複製安裝指令 emits the same prompt as the legacy tab

Clicking 複製安裝指令 calls `navigator.clipboard.writeText(...)` with a string
identical (modulo trailing whitespace) to the one the legacy `updatePrompt()`
function emits at `src/public/index.html:1474-1480`.

### Scenario: user selects install prompt for a user

- **GIVEN** the user has `api_key = 'sk-abc123'`
- **AND** the page derives `getApiUrl()` from `location.origin`
- **WHEN** the actor clicks 複製安裝指令
- **THEN** the clipboard contains a string starting with `幫我安裝 OwnMind：`
  containing `curl -sL https://raw.githubusercontent.com/miou1107/ownmind/main/install.sh | bash -s -- sk-abc123 <api_url>`
- **AND** a toast confirms the copy

## Requirement 6 — Add user honours the server's password-generation contract

The "+ 新增使用者" button opens a modal that calls `POST /api/admin/users`.
When the response contains `default_password`, the modal replaces the form
with a copyable panel showing the one-shot password + email + a note that this
is the only time it appears.

### Scenario: admin adds a user role without a password

- **WHEN** admin submits the add-user form with role=`user` and no password
- **AND** the server returns `{ id, email, ..., default_password: 'xxxxxx' }`
- **THEN** the modal replaces the form with the one-shot password panel; the
  password appears exactly once; a copy button is present; closing the modal
  cannot recall the password (this matches the server's one-shot contract)

## Requirement 7 — 修改密碼 modal follows legacy branching

The password modal has two shapes, decided by whether the actor is a
super_admin resetting someone else's password:

- **self-change**: `oldPassword` + `newPassword` + confirmation. Submit calls
  `POST /api/admin/users/<self>/password` with `{ oldPassword, newPassword }`.
- **super_admin-reset-other**: `newPassword` + confirmation only. Submit calls
  the same endpoint with `{ newPassword }` (no `oldPassword`).

The server (`src/routes/admin.js:345-357`) enforces which branch is legal;
the client only decides which fields to show.

### Scenario: super_admin resets an admin's password

- **THEN** the modal shows only `newPassword` + confirmation; `oldPassword` is
  not rendered

### Scenario: an admin changes their own password

- **THEN** the modal shows `oldPassword` + `newPassword` + confirmation

## Requirement 8 — Emergency reset endpoint stays unsurfaced

Neither the users list nor any modal calls `POST /api/admin/users/:id/reset-password`.
This is a deliberate scope decision documented in the proposal; the endpoint
stays reachable by direct API call but no UI path leads to it.

Asserted by grep: `client/src/pages/Admin/` contains no reference to
`reset-password` (with the hyphen).
