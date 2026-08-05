# v1.26.49 — Tasks

Legend: `[ ]` pending · `[x]` done

Stage 2 of `single-console-consolidation`. Rebuild "使用者管理" as a real
console page. Follow the project's TDD flow: red tests before source, then
docs, then quality gates.

## Phase 0 — Reproduce (already done in Phase 0 report)

- [x] Legacy users tab UI inventory captured in the Phase 0 report (see
      TaskList history and the umbrella tasks.md)
- [x] Backend API inventory: `GET/POST/PUT/DELETE /api/admin/users`,
      `POST /api/admin/users/:id/password`, `GET /api/usage/team-stats`
- [x] Console signpost currently at `client/src/App.jsx` → `<Signpost>` via
      `isSignpost('/admin/team')`
- [x] Users table schema captured (`db/001_init.sql`, `005`, `010`)
- [x] Mockup rendered and approved by Vin 2026-07-31

## Phase 1 — RED (failing tests before any source change)

- [ ] `tests/team-page.test.js` (new). Node test with jsdom, mounts
      `TeamPage` via a minimal SessionContext + LocaleContext harness:
  - [ ] With four mocked users (super_admin / admin / user / user), renders
        six columns in the required order
  - [ ] Row that has no `/api/usage/team-stats` totals renders "尚無資料"
        italic, not `0`
  - [ ] `must_change_password: true` renders the amber 待改 pill
  - [ ] With one super_admin and no admins, single-admin banner is present;
        with an added admin, banner disappears
  - [ ] Dropdown items conditional-render per Requirement 4 (assert visible
        set for three actor/row combos)
- [ ] `tests/team-page-install-prompt.test.js` (new). Clicking 複製安裝指令
      writes the expected string to a stubbed clipboard, containing the user's
      `api_key` and a URL derived from `location.origin`
- [ ] Update `tests/legacy-console-manifest.test.js` to expect
      `team-management` at `state: 'live'` and `isSignpost('/admin/team')` to
      be false. This will fail against the current manifest (which is at
      `signpost`) — the failure IS the RED evidence
- [ ] Update `tests/console-nav-structure.test.js` (or the e2e equivalent) if
      it asserts amber-dot for 成員. Amber dot must be absent after this stage
- [ ] Run and confirm every new/updated assertion fails for the right reason

## Phase 2 — GREEN (source changes)

Write in dependency order so incremental green ticks are meaningful:

- [ ] `client/src/pages/Admin/TeamPage.jsx` — main page: table + banner + effect
      that fires two parallel `apiGet` calls, merges on user id, computes
      derived state via `useMemo`. Follow the pattern of
      `client/src/pages/Portal/UsagePage.jsx`
- [ ] `client/src/pages/Admin/RowMenu.jsx` — the four-item dropdown, positioned
      absolute relative to a per-row anchor. Encapsulates the visibility
      predicates from Requirement 4
- [ ] `client/src/pages/Admin/AddUserModal.jsx` — form → post → one-shot
      password panel path
- [ ] `client/src/pages/Admin/EditUserModal.jsx` — role + name update; email
      read-only
- [ ] `client/src/pages/Admin/PasswordModal.jsx` — self / super-admin-reset
      branching from Requirement 7
- [ ] `client/src/pages/Admin/DeleteUserModal.jsx` — confirm delete; red
      button, keyboard-safe (Escape closes)
- [ ] `client/src/utils/install-prompt.js` — extract `buildInstallPrompt(user,
      apiUrl)` so the test can call it deterministically; the page component
      calls it via a click handler that also invokes clipboard + toast

## Phase 3 — Wire routing + manifest

- [ ] `client/src/App.jsx`: register `TeamPage` in `REAL_PAGES['/admin/team']`
- [ ] `shared/legacy-console-manifest.js:52`: flip `state: 'signpost'` →
      `state: 'live'`
- [ ] Verify `isLegacyConsoleRetired()` still returns `false` (five other
      signposts remain); `/admin/` must still be served

## Phase 4 — i18n

- [ ] `client/src/i18n/zh.json`: add `team.*` keys covering column headers,
      badges, dropdown items, modal titles, error messages, toast text
- [ ] Mirror the same keys in `en.json` and `ja.json`
- [ ] Confirm existing `nav.members` key still points at the same 使用者管理
      string (it does, verified in the Phase 0 report). No key rename this
      stage
- [ ] Grep `client/src/pages/Admin/*` for hard-coded Chinese strings —
      everything visible should route through `useT()`

## Phase 5 — Repeat: run every test, confirm green

- [ ] `npm test` full suite — 2312 was the baseline after v1.26.48; expect
      the new test count to add ~15-25 assertions
- [ ] Run the client build (`npm run build --prefix client`) — must exit 0;
      the SPA shell should load without console errors when served locally
- [ ] Verify the manifest change did not silently retire `/admin/`: hit
      `GET /admin/` in a local dev server, expect 200 not 301

## Phase 6 — Docs

- [ ] `CHANGELOG.md` — v1.26.49 entry (Chinese, matches project's narrative
      convention)
- [ ] `FILELIST.md` — list new / modified / renamed files with per-file
      one-line "why" notes
- [ ] `README.md` and `docs/README.{zh-TW,ja}.md` — bump version, and if any
      section mentions "使用者管理 在舊後台", correct it
- [ ] `openspec/changes/single-console-consolidation/tasks.md`: check off
      Stage 2, mark Stage 3 (系統設定 + 廣播管理) as next

## Phase 7 — Version bump

- [ ] `package.json` → `1.26.49`
- [ ] `SERVER_VERSION` (derived from `package.json` — verify by import path)
- [ ] Git tag `v1.26.49` after commit (recorded here per IR-031 three-way
      version rule)

## Phase 8 — Quality gates (IR-045, non-skippable)

- [ ] `superpowers:verification-before-completion` — evidence per claim
- [ ] `superpowers:requesting-code-review` — dispatch reviewer subagent with
      focused brief (mirror the v1.26.48 dispatch shape)
- [ ] `superpowers:receiving-code-review` — process findings with rigour, not
      performatively

## Phase 9 — Ship

- [ ] Commit `feat(v1.26.49): ...`. Include only Stage 2 files; leave the
      unrelated `hooks/ownmind-reply-lint.js` + `mcp/index.js` modifications
      + the `docs/superpowers/specs/2026-07-31-*` file untouched (same as
      v1.26.48 did)
- [ ] Tag `v1.26.49` pointing at the commit
- [ ] Push `main` + tag to origin
- [ ] Deploy to kkvin.com: `ssh root@kkvin.com "cd /VinService/ownmind &&
      git fetch --tags && git checkout v1.26.49 && docker compose build
      --no-cache api && docker compose up -d api"`. This is the correct
      checkout path per memory 745; `/root/.ownmind` is the unrelated personal
      checkout
- [ ] Confirm the container starts, migrations 17/17 applied (no new DB
      changes this stage)
- [ ] Browser check on production (requires admin login — flag to Vin what
      needs verifying by hand):
      - Sidebar 成員 no longer carries the amber dot
      - Users table loads with real data
      - 用量資料 column shows real numbers or 尚無資料 for each row
      - 複製安裝指令 copies a valid install prompt
      - Add user with role=`user`, no password → one-shot password panel
      - Change a role via 修改角色·名字 → server accepts
      - Change own password → old password required
      - Delete a test user → row disappears

## Followups filed here, not fixed here

- **Emergency reset endpoint has no UI.** `POST /api/admin/users/:id/reset-password`
  is reachable by direct API call; the UI does not surface it. Reason: Vin's
  2026-07-31 call — keep behaviour parity with the legacy tab (admin types the
  new password). Reopens if a future stage takes on account-security
  hardening.
- **`PUT /api/admin/users/:id`'s email change** is left read-only in the edit
  modal. The server allows it; legacy UI never exposed it. Explicit blast-radius
  containment for this stage.
- **`usage_metrics_daily` reference in the umbrella spec is stale**; the actual
  table is `token_usage_daily`. Not fixed here to keep this stage's diff
  focused on the client; will be corrected as part of the stage-close docs
  pass.

## Cross-cutting checks (per the umbrella program)

- [ ] Role gating enforced at both sidebar (`nav-sections.js`) and route
      (`RequireRole` wrapping the entire admin subtree in `App.jsx`)
- [ ] Missing data marked, not shown as zero (Requirement 7)
- [ ] Destructive delete button red + separated from edit (IR-013)
- [ ] Manifest entry flipped; `/admin/` still served (Requirement 5)
- [ ] Server and client both reviewed (IR-022)
- [ ] CHANGELOG / FILELIST / README ×3 in the same commit
- [ ] No test data created on production during browser check; if any was
      created, clean up before closing this stage
