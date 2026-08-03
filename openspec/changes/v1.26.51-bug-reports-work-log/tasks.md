# v1.26.51 — Task list

Order is TDD-forward: RED first, GREEN after. Manifest flip is the last logic
change before the release phase so the tests fail loudly if the wiring is
wrong.

## Phase 0 — Prep

- [x] Inventory legacy 錯誤回報 + 工作紀錄 tabs (`src/public/index.html` cards
      + JS handlers)
- [x] Confirm API contract from `src/routes/bug-reports.js` and
      `src/routes/admin-work-log.js`
- [x] Decide: 封鎖期內使用者 card is dropped (see proposal § "One card
      dropped")

## Phase 1 — Failing tests (RED)

- [ ] `tests/bug-report-row-vm.test.js` — pure `bugReportRowVm(row, userMap)`
      returns severity / status classes, user-map join with graceful
      `user#{id}` fallback, timestamp slice
- [ ] `tests/bug-status-update-validate.test.js` — every server-mirror rule:
      status enum, wontfix requires reason, wontfix_other requires note
- [ ] `tests/work-log-query.test.js` — `buildWorkLogQuery(filters, offset,
      limit)` returns URLSearchParams; every optional filter key maps
      correctly; date-to-ISO conversion stable; offset/limit propagate
- [ ] `tests/work-log-row-vm.test.js` — three source colors, empty details ⇒
      `—`, truncation to 200 chars, summary preferred over details, tooltip
      carries full text
- [ ] Update `tests/legacy-console-manifest.test.js` — assert `bug-reports`
      and `work-log` at `state: 'live'`, three signposts remain
- [ ] Run node --test — confirm all new tests fail for the right reason
      (source files not yet exist / manifest still at signpost)

## Phase 2 — Implementation (GREEN)

### Bug reports page

- [ ] `client/src/pages/Admin/bug-report-row-vm.js` — pure view-model function
- [ ] `client/src/pages/Admin/bug-status-update-validate.js` — pure validator
      mirroring server rules
- [ ] `client/src/pages/Admin/BugReportsPage.jsx` — main page: stat cards,
      sub-tab toggle, filter dropdown, table, load logic
- [ ] `client/src/pages/Admin/BugReportDetailModal.jsx` — detail + status
      editor, calls `PATCH /api/bug-reports/:id/status`
- [ ] `client/src/pages/Admin/SpamSuspectModal.jsx` — confirm/dismiss modal;
      red confirm button, separated from cancel

### Work log page

- [ ] `client/src/pages/System/work-log-query.js` — pure `buildWorkLogQuery`
- [ ] `client/src/pages/System/work-log-row-vm.js` — pure per-row view-model
- [ ] `client/src/pages/System/WorkLogPage.jsx` — filter form, table, load-more,
      calls `/api/admin/work-log` + `/filters`

### Wiring

- [ ] `client/src/App.jsx` — add imports; register `/admin/bugs` and
      `/system/work-log` in `REAL_PAGES`
- [ ] `shared/legacy-console-manifest.js` — flip `bug-reports` and `work-log`
      to `state: 'live'` with updated inline comment
- [ ] `client/src/i18n/{zh,en,ja}.json` — add keys under `bug_reports.*` and
      `work_log.*`

## Phase 3 — Quality gate

- [ ] Run full suite (`npm test`) — expect ≥ 2420 tests green (~30 new)
- [ ] Skill: `superpowers:verification-before-completion` — build client
      passes, docker container image can start (dry-run compose config)
- [ ] Skill: `superpowers:requesting-code-review` — self-review pass to
      catch anything the tests miss
- [ ] Skill: `superpowers:receiving-code-review` — process each finding
      rigorously

## Phase 4 — Release

- [ ] Bump package.json 1.26.50 → 1.26.51
- [ ] Update CHANGELOG.md with v1.26.51 entry (zh)
- [ ] Update FILELIST.md with v1.26.51 file list (zh)
- [ ] Update README.md, docs/README.zh-TW.md, docs/README.ja.md — version
      number in three locales
- [ ] Update umbrella `single-console-consolidation/tasks.md` — Stage 4
      checkbox
- [ ] git commit + tag v1.26.51 + push main + tag

## Phase 5 — Deploy

- [ ] SSH root@kkvin.com: `cd /VinService/ownmind && git fetch --tags &&
      git checkout v1.26.51 && docker compose build --no-cache api &&
      docker compose up -d api`
- [ ] Verify container up, migrations at 17/17 unchanged
- [ ] Verify local asset hash matches production (byte-for-byte)
- [ ] Verify `/admin/` still 200 (three signposts remain)
- [ ] Verify `/api/bug-reports` and `/api/admin/work-log` return 401 unauth

## Phase 6 — Post-deploy browser verify (needs Vin login)

Filed as a separate task; needs Vin's admin + super_admin login credentials.

- [ ] Sidebar 錯誤回報 and 工作紀錄 no longer have amber dots
- [ ] `/admin/bugs` renders: stat cards, sub-tabs, filter dropdown
- [ ] Click a report row → modal opens with detail + status editor
- [ ] Change a report status → PATCH lands → row reflects new status
- [ ] Switch to spam suspect sub-tab → table renders → modal opens
- [ ] `/system/work-log` renders: filters populated, initial 30-day query runs
- [ ] Apply a filter → query hits with the right params
- [ ] Click 載入更多 → offset advances, rows append
- [ ] `/admin/` still opens (three signposts remain)
