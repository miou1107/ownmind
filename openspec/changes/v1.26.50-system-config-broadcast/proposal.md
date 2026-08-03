# v1.26.50 — Split the legacy 設定 tab into 系統設定 + 廣播管理

Stage 3 of `single-console-consolidation`. Two more `/admin/` amber dots
disappear when this ships: 系統設定 and 廣播管理 stop being signposts and
become real console pages, each backed by the same server API the legacy tab
already calls. Two remain (工作紀錄, 錯誤回報); three more stages after that
retire what's left.

The legacy 設定 tab held three cards. This stage ports two. The third — 成本
設定 · Model 定價 — is a deliberate non-goal, dropped along with its API in
Stage 8 per Vin's 2026-07-30 call.

## What changes for the user

- `/system/config` becomes a real page: **裝機狀況** + a new banner surfacing
  the state the old coverage metric hid.
- `/system/broadcast` becomes a real page: CRUD for admin broadcasts.
- Both amber dots in the sidebar (系統設定, 廣播管理) disappear.
- The other five signposts still point at `/admin/`.

## The role split

Old legacy tab has one permission (admin+) covering three cards with three
different real permissions:

| Card | Legacy markup | Real API permission | Ported to |
|---|---|---|---|
| 成本設定 · Model 定價 | `super-admin-only` | `superAdminAuth` | **not ported** (Stage 8 deletion) |
| 廣播管理 | `super-admin-only` | `superAdminAuth` (POST/PATCH/DELETE), `adminAuth` (GET) | `/system/broadcast`, super_admin only |
| 裝機狀況 | no class → admin+ | `adminAuth` | `/system/config`, admin+ |

Manifest and navigation already model this (v1.26.46): `/system/config` at
admin+, `/system/broadcast` at super_admin. This stage does not renegotiate;
it just flips the two signpost entries to `live`.

## What `/system/config` shows

裝機狀況 as the legacy tab shows it, plus one thing: an **info banner at the
top of the page** distinguishing three states from the coverage roll-up the
old tab flattened:

- **collector 靜默** — heartbeat present in `collector_heartbeat`, but zero
  rows in `token_usage_daily` for the same user in the observation window.
  This is the hazard state umbrella spec Requirement 7 calls out: the old
  metric counted these members as "已裝", which is technically true and
  operationally wrong.
- **未裝** — no heartbeat, never.
- **正常運作** — heartbeat + at least one usage row in the window.

The banner names counts and lists the silent users by name. No new API — reads
`/api/usage/admin/clients` and `/api/usage/team-stats` in parallel and joins
client-side, same shape as `TeamPage`.

The per-tool table below stays behaviour-identical to the legacy card: user,
email, role, overall status, per-tool version / heartbeat / upgrade flag.

## What `/system/broadcast` shows

Everything the legacy 廣播管理 card exposes, laid out for a console with a
sidebar rather than a full-page tab:

- List of all broadcasts (`GET /broadcast/admin?include_ended=true`), newest
  first, up to 200.
- Row shows: 建立時間, type badge, severity, title (click expands body),
  effective range, snooze setting, action (撤銷 for active non-auto).
- `is_auto` rows are marked and not revocable — the nightly job re-creates
  them the next run, so a manual revoke is meaningless. Same rule the legacy
  UI encoded inline (`is_auto` → no button).
- Expired rows render at 45% opacity, matching the legacy `style="opacity:0.45"`.
- "+ 新增廣播" button opens a modal — same shape as the legacy modal at
  `src/public/index.html:925-966`, ported field-for-field.

super_admin only, both at the route and at the sidebar.

## Non-goals

- **No new backend endpoint.** Both pages reuse routes the legacy tab already
  calls. Same rule as v1.26.49.
- **No touching `/api/broadcast/*` semantics.** Filter contract, `is_auto`
  branching, `target_users` handling — all unchanged. This stage is client-only
  plus the manifest flip.
- **Model 定價 is not built.** The pricing card in the legacy tab and its
  underlying `/api/usage/pricing` route are both slated for deletion in Stage
  8 (Vin 2026-07-30). Any code touching pricing here would be work
  immediately undone.
- **Broadcast PATCH is not surfaced.** The legacy tab never exposed edit
  either — only create and revoke. Add it if a real workflow needs it; not
  needed to reach parity with the legacy card.

## Approach

- **Page pattern**: mirror `TeamPage.jsx` — hook-based state, `apiGet` from
  `../../api`, `useT()` for i18n, `useMemo` for derived state, extracted
  pure functions in sibling `.js` files for testability.
- **Data merge for 裝機狀況**: `usage.observedUsers(clientsData, teamStats,
  windowDays)` — pure function in `client/src/pages/System/observed-users.js`
  returns `[{ user, heartbeat, usage, state }]`. State is one of `flowing |
  silent | not_installed | offline` (offline covers stale/needs-upgrade rolled
  up). Silent is the Requirement 7 addition.
- **Broadcast rendering**: pure `broadcastRowVm(row, now)` returns
  `{ isActive, isRevocable, typeBadge, severityBadge, effectiveRange,
  snoozeLabel }` — separates policy from JSX.
- **Modal state**: single component `NewBroadcastModal.jsx` with local form
  state. No shared modal container — same pattern as TeamPage's four modals.
- **Manifest flip**: two lines in `shared/legacy-console-manifest.js`. Console
  reads `isSignpost()` at render time; the sidebar's amber dot on 系統設定
  and 廣播管理 disappear automatically. `/admin/` stays served because five
  other entries are still signposts.

## Testing

- **Pure function tests** — `tests/observed-users.test.js` and
  `tests/broadcast-row-vm.test.js`. Node --test, no jsdom. Covers:
  - Heartbeat present + zero usage → `silent`
  - Heartbeat absent → `not_installed`
  - Heartbeat + usage rows → `flowing`
  - Stale heartbeat + old usage → `offline`
  - `is_auto` row → not revocable
  - Active row after `ends_at` → not revocable (already ended)
  - Snooze off → snooze label empty
- **Manifest test** (updates existing `tests/legacy-console-manifest.test.js`):
  `system-config` and `broadcast` both at `state: 'live'`; `isSignpost()`
  returns false for both console paths; `isLegacyConsoleRetired()` still
  returns false (five signposts remain).
- **App-routing test**: `/system/config` and `/system/broadcast` register in
  `REAL_PAGES` with `SystemConfigPage` and `BroadcastPage` respectively.
- **Role-gate test** (existing `console-nav-structure.test.js`): the two
  paths' `minRole` matches their `RequireRole` gate — admin+ for config,
  super_admin for broadcast.
- **e2e** (existing `console.spec.mjs`): admin sees 系統設定 in sidebar
  without the amber dot; a `user` sees neither 系統設定 nor 廣播管理;
  super_admin sees both without amber dots.

## Known limitation

The "collector 靜默" detection is per-observation-window, defaulting to 7d.
A member with heartbeat but zero usage genuinely on leave for the whole
window will surface as silent — this is intentional. The banner says "近 7
天無使用紀錄", not "壞掉", to keep the framing honest. A user on annual leave
looking at the page for their own team can read the counts, name the leave
member, and move on. A future stage may raise a preference to change the
window size; not this stage.

## Filed, not fixed here

- **`GET /api/broadcast/admin?include_ended=true`** returns rows without a
  server-set `now`; the client decides "expired" via `Date.now()`. If the
  server clock and the browser clock diverge, borderline rows read
  inconsistently across users. Not new — the legacy card had the same bug —
  and not fixed here to keep the diff client-side. Refile if it ever bites.
- **`admin+` can list broadcasts but the sidebar item is super_admin-only**,
  so today an admin never sees the list. If a future stage opens the sidebar
  item to admin, the create/revoke actions will need to hide too. Recorded
  in tasks.md.
