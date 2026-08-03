# v1.26.50 — Tasks

Legend: `[ ]` pending · `[x]` done

Stage 3 of `single-console-consolidation`. Rebuild 系統設定 (裝機狀況) and
廣播管理 as two real console pages. TDD flow: red tests before source, then
docs, then the three quality gates.

## Phase 0 — Reproduce (already done in this session's exploration)

- [x] Legacy 設定 tab has three cards: 成本設定, 廣播管理, 裝機狀況. Pricing
      is not ported (Stage 8 deletion). Two cards map to two console pages
- [x] Backend APIs inventoried: `GET /api/usage/admin/clients` (admin+),
      `GET/POST/PATCH/DELETE /api/broadcast/admin` (admin GET, super_admin
      mutations), `GET /api/usage/team-stats` for the silent-user cross-check
- [x] Console signposts currently at `/system/config` and `/system/broadcast`,
      driven by `shared/legacy-console-manifest.js` entries 3 and 4
- [x] Manifest paths and nav-sections role gates already resolved by v1.26.46
      (admin+ / super_admin split). This stage does not renegotiate roles

## Phase 1 — RED (failing tests before any source change)

- [ ] `tests/observed-users.test.js` (new). Pure function that joins
      `/api/usage/admin/clients` output with `/api/usage/team-stats` output
      by user id, returning per-user state (`flowing | silent | not_installed
      | offline`). Cases:
  - [ ] Heartbeat fresh + usage rows > 0 → `flowing`
  - [ ] Heartbeat fresh + zero usage rows → `silent` (Requirement 7)
  - [ ] Heartbeat absent → `not_installed`
  - [ ] Only stale heartbeat + zero usage → `offline`
  - [ ] Roll-up counts sum to total_users
- [ ] `tests/broadcast-row-vm.test.js` (new). Pure function derives per-row
      view-model from a broadcast row + current time. Cases:
  - [ ] Active manual → `{ isActive: true, isRevocable: true }`
  - [ ] Active `is_auto` → `{ isActive: true, isRevocable: false }`
  - [ ] `ends_at` in the past → `{ isActive: false, isRevocable: false }`
  - [ ] Snooze off → snoozeLabel empty; snooze on → `24h` etc
- [ ] `tests/broadcast-payload-validate.test.js` (new). Client re-uses server's
      `validateBroadcastPayload`. Cases: title blank, body over 2000, invalid
      ends_at, snooze_hours ≤ 0 (when allow_snooze) — each returns an error
      string; valid payload returns null
- [ ] Update `tests/legacy-console-manifest.test.js`:
      `system-config` and `broadcast` both at `state: 'live'`;
      `isSignpost('/system/config')` and `isSignpost('/system/broadcast')`
      both false; `isLegacyConsoleRetired()` still false (5 signposts remain).
      This fails against the current manifest — the failure IS the RED
- [ ] Update `tests/console-nav-structure.test.js` if it asserts amber-dot
      for 系統設定 or 廣播管理. Amber dots must be absent after this stage;
      `RequireRole` gates match `minRole` for both paths

## Phase 2 — GREEN (source changes)

Write in dependency order so incremental green ticks are meaningful:

- [ ] `client/src/pages/System/observed-users.js` — pure joiner + counter
- [ ] `client/src/pages/System/broadcast-row-vm.js` — pure row view-model
- [ ] `client/src/pages/System/broadcast-payload-validate.js` — validator
      (mirrors server's `validateBroadcastPayload`)
- [ ] `client/src/pages/System/SystemConfigPage.jsx` — banner + table, effect
      that fires two parallel `apiGet` calls, `useMemo` over the joiner.
      Pattern: `TeamPage.jsx`
- [ ] `client/src/pages/System/BroadcastPage.jsx` — list + toolbar + "+ 新增
      廣播" trigger. Effect fires `GET /api/broadcast/admin?include_ended=true`
- [ ] `client/src/pages/System/NewBroadcastModal.jsx` — modal form; local
      state; validates client-side before POST; renders inline error
- [ ] `client/src/pages/System/RevokeConfirmDialog.jsx` — small dialog with
      the destructive-button rule (red text, kept away from cancel)

## Phase 3 — Wire routing + manifest

- [ ] `client/src/App.jsx`: register both pages in `REAL_PAGES`
- [ ] `shared/legacy-console-manifest.js:59-60`: flip `state: 'signpost'` →
      `state: 'live'` for both entries
- [ ] Verify `isLegacyConsoleRetired()` still returns false (5 signposts
      remain); `/admin/` must still be served

## Phase 4 — i18n

- [ ] `client/src/i18n/zh.json`: add `system.config.*` and `system.broadcast.*`
      keys — page titles, banner phrases, column headers, modal titles,
      button labels, error messages, toast text
- [ ] Mirror the same keys in `en.json` and `ja.json`
- [ ] Grep `client/src/pages/System/*` for hard-coded Chinese strings

## Phase 5 — Repeat: run every test, confirm green

- [ ] `npm test` full suite — 2340 was the baseline after v1.26.49; expect
      the new test count to add ~25-35 assertions
- [ ] Run the client build (`npm run build --prefix client`) — must exit 0

## Phase 6 — Docs

- [ ] `CHANGELOG.md` — v1.26.50 entry (Chinese, matches project convention)
- [ ] `FILELIST.md` — list new / modified files with per-file one-line "why"
- [ ] `README.md` and `docs/README.{zh-TW,ja}.md` — bump version, mention
      Stage 3 progress
- [ ] `openspec/changes/single-console-consolidation/tasks.md`: check off
      Stage 3, mark Stage 4 as next

## Phase 7 — Version bump

- [ ] `package.json` → `1.26.50`
- [ ] `SERVER_VERSION` (derived from `package.json`) — verify
- [ ] Git tag `v1.26.50` after commit (IR-031)

## Phase 8 — Quality gates (IR-045, non-skippable)

- [ ] `superpowers:verification-before-completion`
- [ ] `superpowers:requesting-code-review`
- [ ] `superpowers:receiving-code-review`

## Phase 9 — Ship

- [ ] Commit `feat(v1.26.50): ...`. Include only Stage 3 files; leave
      unrelated modifications alone as v1.26.48 and v1.26.49 did
- [ ] Tag `v1.26.50` pointing at the commit
- [ ] Push `main` + tag to origin
- [ ] Deploy to kkvin.com: `ssh root@kkvin.com "cd /VinService/ownmind &&
      git fetch --tags && git checkout v1.26.50 && docker compose build
      --no-cache api && docker compose up -d api"`
- [ ] Container starts, migrations 17/17 applied (no new DB changes)
- [ ] Browser check on production:
      - Sidebar 系統設定 and 廣播管理 no longer carry the amber dot
      - `/system/config`: banner shows three counts, table loads
      - `/system/broadcast`: list loads, "+ 新增廣播" opens modal
      - super_admin can create + revoke a test broadcast; clean up after
      - admin sees 系統設定 but not 廣播管理; user sees neither
      - `/admin/` still 200 with the legacy tab (5 signposts remain)

## Followups filed here, not fixed here

- **Broadcast PATCH endpoint has no UI**. `/api/broadcast/admin/:id` PATCH
  can edit `ends_at` / `target_users` on an existing row. Legacy UI never
  exposed it either — this stage keeps parity. Refile if a real workflow
  emerges.
- **Client-side "expired" is decided by `Date.now()`** in `broadcast-row-vm`.
  If the server and browser clocks diverge past a row's ends_at, the row's
  state reads inconsistently. Not new (legacy card had the same bug), not
  worth fixing until it bites.
- **`GET /api/broadcast/admin`** is `adminAuth`, but the sidebar item is
  super_admin-only. If a future stage opens the sidebar entry to admin, the
  create + revoke actions will need to hide client-side (server already
  rejects them).

## Cross-cutting checks (per the umbrella program)

- [ ] Role gating enforced at both sidebar (`nav-sections.js`) and route
      (`RequireRole` wrapping the admin subtree in `App.jsx`)
- [ ] Missing data marked, not shown as zero (Requirement 7)
- [ ] Destructive revoke button red + separated from cancel (IR-013)
- [ ] Two manifest entries flipped; `/admin/` still served
- [ ] Server and client both reviewed (IR-022)
- [ ] CHANGELOG / FILELIST / README ×3 in the same commit
- [ ] No test data created on production during browser check; if any was
      created, clean up before closing this stage
