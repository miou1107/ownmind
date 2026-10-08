# Tasks — v1.32.0 console rebuild

Each phase ships on its own. A phase is done when its tests pass on Mac/Linux/Windows CI,
the page works at phone width in light and dark, and the old paths it replaces redirect.

## Phase 0 — which server each machine talks to

- [x] `db/031_collector_api_host.sql`: `collector_heartbeat.api_host VARCHAR(255) NULL`
- [x] scanner heartbeat sends `api_host` (host only) — `shared/scanners/base.js` postBatch, so every heartbeat carries it
- [x] `src/routes/usage/events.js`: accept, length-check and store `api_host`; an older
      client that sends none leaves the stored value alone
- [x] `src/routes/usage/admin-clients.js`: return `api_host` and `on_old_host`
- [x] `/system/config`: column 「連的主機」, red pill when `on_old_host`
- [x] tests: heartbeat with and without `api_host`; admin list flags kkvin.com
- [ ] release, deploy, then read the list to close #152 step 2

## Phase 1 — shell and navigation

- [x] `nav-sections.js`: 7 entries, roles per entry and per tab (NAV_ENTRIES, OLD_PATHS)
- [x] tab state in the URL (`/home`, `/inbox/handoffs`, …) so a tab can be linked
- [x] redirects from all 20 old paths to their new tab (18 redirect, `/team/stats` and `/team/tasks` kept their address)
- [x] left rail, collapses to a menu under 960px — the 待你處理 count arrives with Phase 3, which builds the endpoint it needs
- [x] `tests/e2e/console.spec.mjs` and `tests/console-nav-structure.test.js` updated for the entries, tabs and redirects

## Phase 2 — 總覽

- [x] `/api/me/overview`: lights, pending counts, four tiles, daily sessions — composed
      from existing queries (`src/routes/me-overview.js`)
- [x] three status lights, each with its action button
- [x] 「等你處理」 list linking into the inbox tabs
- [x] four tiles with one comparison sentence each; 7/14/30-day range
- [x] remove the three banners from the old usage page

## Phase 3 — 待你處理

- [ ] tabs 交接／學到的／任務卡／錯誤回報(admin), each a list with one primary button
- [ ] reuse the existing handoff accept, lesson keep/dismiss, task review, bug status APIs
- [ ] an item handled disappears without a reload; counts in the rail update

## Phase 4 — 用量與規矩

- [ ] 我的對話: tiles, daily chart, my machines with version and 連的主機
- [ ] 規矩遵守: rate with formula, per-rule bars, 「AI 沒回報的對話」 (old pitfalls)
- [ ] 專案: project table, row opens who and handoffs
- [ ] 全隊 (admin): team tiles, daily chart, time-of-day and weekday bars

## Phase 5 — 團隊、記憶、我的設定、管理

- [ ] 團隊 › 成員: one table, 「OwnMind 看得到嗎」 column, side drawer per person
- [ ] 團隊 › 觀察 and 週報 (admin): existing narrative and periodic reports
- [ ] 記憶: project history with search; rules list
- [ ] 我的設定: profile, password, secrets
- [ ] 管理: users (add/edit/delete/password), 每台電腦的回報, 公告, 工作紀錄

## Phase 6 — cleanup

- [ ] delete the old page components and their view-models no longer imported
- [ ] copy pass against the prototype's wording rules
- [ ] FILELIST, README ×3, CHANGELOG, version
