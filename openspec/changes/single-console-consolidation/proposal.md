# Single-console consolidation — collapse /admin/, /me/ and /dashboard/ into one

**Type**: multi-stage program. Each stage below becomes its own version-prefixed
OpenSpec change. This document is the umbrella that keeps them coherent.

**Status**: designed, not started. Approved by Vin on 2026-07-30.

## Goal

One console. Today there are three authenticated web UIs plus an unauthenticated
first-run wizard. The end state is a single console at `/dashboard/`, with
`/admin/` and `/me/` retired to 301 redirects and their sources preserved as
read-only historical snapshots.

## Background — how we got three consoles

The v1.20 series rebuilt the console as a React SPA at `/dashboard/`, deliberately
running blue-green alongside the two older UIs. `v1.20.4-legacy-retire` was written
to retire the old ones. It was written as a stub, gated on "feature parity plus
Vin's go-ahead", and then **archived without being executed**. Sitting in
`openspec/changes/archive/`, it reads as completed work. Nothing in the codebase
prevented that.

That is the failure mode this program is designed against, and it is why Requirement 5
in `spec.md` makes retirement a structural consequence of finishing the work rather
than a checklist item anyone has to remember.

## Current inventory (measured 2026-07-30)

| Surface | Source | Size | Auth |
|---|---|---|---|
| `/admin/` | `src/public/index.html` | 2985 lines, single file, inline JS | `/api/admin/login` |
| `/me/` | `src/public/me/index.html` | 1470 lines, single file, inline JS | `/api/me/login` |
| `/dashboard/` | `client/` React SPA | 8 routed pages across 11 component files | `/api/me/login` |
| `/setup` | `src/public/setup.html` | 196 lines | none by design (users table empty) |

`GET /` redirects to `/ownmind/admin/` (`src/app.js:155`), so the **old** console is
the default landing page and the new one is effectively unreachable by navigation.

### Feature mapping

The old `/admin/` has eight tabs. The new console's sidebar has twelve nav items,
seven backed by real pages and five placeholders.

| Old `/admin/` tab | New home | State |
|---|---|---|
| 使用者管理 (users) | `/admin/team` | placeholder — **build**, Stage 2 |
| 設定 → 裝機狀況 | `/super/config` | placeholder — **build**, Stage 3 |
| 設定 → 廣播管理 | `/super/broadcast` | placeholder — **build**, Stage 3 |
| 錯誤回報 (bug-reports) | `/admin/bugs` | placeholder — **build**, Stage 4 |
| 工作紀錄 (work-log) | no route exists | **build** + new nav seat, Stage 4 |
| 統計儀表板 (stats) | no consumer of `/api/activity/*` | **build**, Stage 5 |
| 團隊用量 (team-usage) | no consumer of `/api/usage/*` | **build**, Stage 6 |
| 週/月報 (reports) | no consumer of `/api/session/report` | **build**, Stage 7 |
| 設定 → 成本設定 | — | **drop**, Requirement 8 |
| 鐵律升級 (iron-rule-upgrade) | — | **drop** |

An earlier version of this table marked the last three rebuilds as "done". That was
wrong, and it roughly doubled the real scope when corrected. The console calls none of
`/api/activity/*`, `/api/usage/*` or `/api/session/*`. `/portal/reports` is 回報紀錄
backed by `/api/bug-reports`; the shared `nav.reports` label is what caused the error.

## Four findings that changed the scope

These were measured during design, and each one moved the estimate. They are
recorded because the naive framing ("port five placeholder pages") is wrong.

**1. 廣播管理 is hidden inside the old 設定 tab.** The old settings tab holds three
blocks: 廣播管理, 成本設定 (model pricing), and 裝機狀況. The new sidebar already
splits broadcast into its own nav item. So "settings" is two pages of work, not one.
Both hit the same `/broadcast/admin` API, so the split is cheap.

**2. 稽核記錄 (`/super/audit`) is a nav item nobody built a page for.** Dropped from
the sidebar per YAGNI; Vin's call. The first draft justified this by saying no read API
existed, which was wrong: three tables were conflated. `GET /api/usage/admin/audit`
(`src/routes/usage/admin-audit.js:14`) does read `usage_audit_log`, and a UI for it
exists but is `hidden`, not absent (`src/public/index.html:508-535`, suppressed in
v1.17.20 as "not needed day to day"). Separately, `writeAdminAudit`
(`src/routes/admin-iron-rule-upgrade.js:34-40`) writes to `admin_audit_logs`, a table
**no migration creates**, so those inserts have always failed silently into their
try/catch. And `audit_logs` is written from five places but read only as a dedup
`SELECT 1` at `src/routes/me.js:767`. The conclusion stands; the reasoning did not.

**3. `/me/` is not fully covered by the new usage page.** It calls five API groups.
Three are already covered by pages that exist: `/api/me/login` (the console's
`LoginPage`), `/api/me/change-password` (`SecurityPage`) and `/api/me/profile`
(`ProfilePage`) — verified by reading those three components. The remaining two are
not: `/api/me/narrative` (+ `/narrative/insights`) and `/api/me/pitfalls`. The new
usage page calls only `GET /api/me/report?range=`. So retiring `/me/` as-is would
lose exactly two features: the narrative analysis (the plain-language reading of ten
questions, plus the manager insights and next-action sections) and 踩坑紀錄.
Both APIs already work, so porting them is front-end-only.

`/me/` keeps no state in the URL: `location.hash`, `history.pushState` and
`searchParams` appear zero times in it, and section switching is in-page JavaScript.
So no deep link exists to preserve and a blanket `/me/*` redirect breaks no bookmark.
Measured, because an adversarial review predicted the opposite.

**4. The new console has no role enforcement.** `Sidebar.jsx` gates its four
sections by role correctly, but the role it reads comes from
`useState('super_admin')` hardcoded in `App.jsx`. Every user who logs in sees the
admin and super sections. Routes are wrapped in `RequireAuth` and
`RequireFreshPassword` only — nothing checks *who* you are, so a typed URL reaches
any page. This becomes a real defect the moment the admin pages exist, which is why
Stage 0 blocks everything else.

The first draft added "no data leaks today because server-side `superAdminAuth`
holds". That was false. `GET /api/usage/pricing` was mounted with plain `auth`
(`src/routes/usage/pricing.js:25`) while only `POST` was gated, and the old console hid
its pricing card client-side using the user-writable `om_role` localStorage key. A
`user`-role account could read it. Requirement 8 closes that by deleting the router.

## Options considered

| Option | Verdict |
|---|---|
| Port the remaining features into the React console, then retire the old ones | **Chosen.** |
| Frame the old pages inside the new shell (iframe) to reach "one entry point" immediately | Rejected. `v1.20.4-legacy-retire` is the precedent: a "temporary" two-week coexistence was archived and forgotten. An iframe would pin a 2985-line single-file page with inline JS permanently inside the new console, and inherit auth, i18n and styling mismatches. |
| Reverse direction: grow the old single-file console and delete the SPA | Rejected. Discards the tri-language i18n and the whole v1.20 investment, and keeps a 2985-line single file as the long-term maintenance surface. |
| Retire `/me/` first as a quick win, port narrative + pitfalls later | Rejected by Vin. Losing features mid-consolidation is how consolidations get reverted. |
| Leave `/` pointing at the old console; make the new one an opt-in link until coverage is 100%, then switch once | Raised by adversarial review, rejected by Vin. This is close to the arrangement that has been in force since v1.20 and it is what produced the current state: the new console was reachable but not default, so it went unused and its retirement plan was archived unexecuted. Flipping the entry point early is the forcing function. |

## Chosen sequence

Vin chose "unify the entry point first, then fill in the pages" over "finish
everything, then switch once". The trade-off accepted: during Stages 2-4 he still
visits the old console for user management.

- **Stage 0 — real session identity.** Role, display name and logout from the server;
  routes gain role guards. Blocks every later stage. No new endpoint needed:
  `POST /api/me/login` already returns `role` (`src/routes/me.js:61`).
- **Stage 1a — port the missing `/me/` features, raise the signposts.** Also builds the
  Requirement 5 manifest and the credential handoff. Changes nothing about where users
  land, so it ships safely alone.
- **Stage 1b — flip the entry point, retire `/me/`.** Also fixes `firstRunRedirect`,
  which today would leave a fresh install unable to reach the wizard.
- **Stage 2 — 使用者管理.** First, because it is the only feature whose absence forces a
  trip back to the old console.
- **Stage 3 — 系統設定 (裝機狀況) + 廣播管理.** One old tab split across two pages.
- **Stage 4 — 錯誤回報 + 工作紀錄.** Read-only observability, lowest risk.
- **Stage 5 — 統計儀表板.** 17 blocks, a new `/api/activity/*` integration. Largest stage.
- **Stage 6 — 團隊用量.** Includes replacing the heartbeat-based coverage metric.
- **Stage 7 — 週報月報.** Absent from the console today. Fixes the count query rather
  than porting it. Flipping its manifest entry is what retires the old console.
- **Stage 8 — clean up.** Emergency-recovery login first, then the static mount, the
  legacy snapshot, the breaking tests, and the backend dead code.

One stage per release.

## Transition UX

The placeholder pages currently say "coming soon", which is untrue. They become
signposts: "this feature still lives in the old console" plus a link across. Chosen
over a persistent footer link because a signpost is replaced by the real page as each
stage lands, leaving nothing to remember to remove. The footer link in the original
v1.20.4 plan is exactly the kind of item that gets forgotten.

The signpost count after Stage 1a is five, though not the same five as today: 稽核記錄
is removed, and 工作紀錄 gains a seat it does not have today. So 使用者管理, 錯誤回報,
系統設定, 廣播管理 and 工作紀錄 each get a signpost, and the count falls to zero across
Stages 2-4. Reaching zero is what retires the old console, per Requirement 5.

## Known trap: redirects must be relative

nginx strips the `/ownmind` prefix before proxying, so Express never sees it. An
absolute `res.redirect(301, '/dashboard/')` sends the browser to
`https://kkvin.com/dashboard/`, dropping the prefix. Redirects must be relative
(`../dashboard/`), matching the existing `/me` → `me/` redirect at `src/app.js:89`.

This repo has hit this class of bug twice already: the v1.20.1 `<base href>` fix and
the v1.26.44 deep-link fix. `src/app.js:155` is a live instance — it hardcodes
`/ownmind/admin/`, which means a direct `localhost:3100/` redirects to a path that
does not exist locally. Stage 1b replaces it with a relative redirect.

## Incidental cleanup

`app.use('/admin', express.static(join(__dirname, 'public')))` exposes the **entire**
`src/public/` directory, so `/admin/dashboard/…` and `/admin/me/…` are also reachable
— several URLs for the same files. Stage 5 removes this mount, which resolves it.
Preserved legacy sources must land outside any served path, and `Dockerfile` COPY
directives need to follow the moves.

## Non-goals

- **`/setup` stays separate.** It runs when the users table is empty, before any
  account exists, so it cannot live behind the console's login. It is a bootstrap
  flow, not a fourth console.
- **`/super/audit` is not built.** No API, no old-console counterpart, not requested.
- **`鐵律升級` is not ported.** See the open item below.
- No change to `client/vite.config.js` or the `<base href>` mechanism.
- No redesign of the seven pages that already work.

## Risks

| Risk | Mitigation |
|---|---|
| Stage 5 is forgotten, as v1.20.4 was | Requirement 5. The guard is structural, not a reminder: one manifest drives both the signpost routes and the `/admin` static mount, so the mount stops being registered once the last signpost becomes a real page. See the note on CI below |
| Flipping `/` exposes the un-gated admin nav to regular users | Stage 0 precedes Stage 1a |
| Redirects drop the `/ownmind` prefix | Requirement 4 tests both prefixed and unprefixed forms |
| `/me/` retirement locks out regular members | Not a risk. The new console authenticates against the same `POST /api/me/login`, which selects from `users` with **no role filter**, so every role including `super_admin` can log in and no account or password migration is involved. Verified by reading `src/routes/me.js:34` and `client/src/pages/LoginPage.jsx` |
| Feature loss during the transition | Requirement 3 pins the old feature inventory; narrative + pitfalls ship in Stage 1a, before `/me/` is redirected in 1b |
| Following a signpost forces a second login | Real, and measured. The three consoles store the credential under three different keys (`om_api_key` for `/admin/`, `ownmind_api_key` for `/me/`, `ownmind.api_key` for the console), so they never clobber each other, but neither do they share a session. The **value** is identical: `/api/admin/login` and `/api/me/login` both return the `api_key` column of the same `users` row. So Stage 1a hands the credential across when a signpost is followed, and the old console is already authenticated. Same-origin only |

## Adversarial review round

An independent adversarial review was run against the first draft of these three
documents, before commit. It returned three Critical and three Important findings.
Each was checked against the code rather than accepted or dismissed on plausibility.

**Accepted, and the design changed:**

- **The retirement guard is toothless without CI.** Correct, and the strongest
  finding. This repo has no `.github/workflows/`, so a red suite gates nothing, and
  the person hitting a deliberately-red test at release time is being invited to
  comment it out. The guard was redesigned to be structural: the manifest that
  decides which features are still signposts is the same manifest that decides
  whether the `/admin` static mount is registered at all, so retirement is a
  consequence of finishing rather than a task to remember. The reviewer's own
  suggestion (block server startup) was rejected: taking production down over a
  pending cleanup step is a worse failure than the one being prevented.
  Adding CI remains a separate, higher-priority piece of work; this guard is
  stronger with it.
- **Stage 1, as first drafted, bundled too much.** Correct. Porting two pages, raising signposts,
  flipping the root and retiring `/me/` in one release means any single failure
  removes every user's way in. Split into 1a and 1b.
- **The transition friction was understated.** The conclusion was right, the
  mechanism wrong: the reviewer predicted credentials overwriting each other and
  forced logouts. Measured, the three consoles use three distinct storage keys, so
  no clobbering occurs. The real cost is a second login, now mitigated by the
  credential handoff described in the risk table.

**Refuted by measurement, recorded so the question is not reopened:**

- *"`super_admin` may be unable to log in to the console, since it uses the member
  endpoint."* `POST /api/me/login` selects from `users` with no role filter and
  returns `role` in its response (`src/routes/me.js:34`). Every role can log in.
- *"Change-password and profile editing were left out of the inventory."* Both are
  already built: `SecurityPage` calls `/api/me/change-password` and `ProfilePage`
  calls `/api/me/profile`. The draft did not say so explicitly, which is what
  invited the finding; finding 3 above now states the coverage.
- *"Blanket-redirecting `/me/*` to the usage route breaks saved deep links."*
  `/me/` holds no URL state at all: zero occurrences of `location.hash`,
  `history.pushState` or `searchParams`. There are no deep links to break.

## Rounds two and three, and the prototype

Two further adversarial rounds ran before implementation, one cross-model and one with
repo access. Between them they overturned enough that the plan roughly doubled.

**Accepted from the cross-model round:** the retirement guard as first designed coupled
"last page ships" to "old console goes dark", removing the rollback path exactly when
it is needed. The manifest now carries a third state so retirement follows verification
rather than deployment. Stage 1 was split into 1a and 1b. The credential handoff gained
a role check.

**Accepted from the repo-access round, all verified directly:** three rows of the
mapping table were wrong; retiring `/admin/` would delete the only UI for the
documented sole-admin password recovery; `firstRunRedirect` breaks when the entry point
moves; six test files break; the claim that "no data leaks because superAdminAuth
holds" was false for `GET /api/usage/pricing`; `src/public/dashboard/` is gitignored so
a fresh clone has no console after retirement; the Dockerfile has no per-file COPY, so
the "sync COPY" tasks were premised on directives that do not exist.

**Then a production measurement changed the shape again.** Asked to confirm scope, Vin
said the features are all in use but "the presentation is poor and the data may be
wrong". Measured on the live console: the coverage panel reported 8 of 9 members
reporting while three real members had no usage data at all, because coverage counts
collector heartbeats rather than data. Every member with data showed no cost. The
weekly report's Suggestion Action count rendered empty while the list beneath it had a
row. Those findings produced Requirement 7 and Requirement 8, and they are recorded in
OwnMind memory 740 for the follow-up with the collector side.

**A clickable prototype settled the presentation** before any code: sidebar regrouped
into 我的 / 團隊 / 偏好設定 / 管理 / 系統 with 團隊用量 moved out of 個人分析,
broadcast split out of settings, missing data marked rather than shown as zero, charts
paired instead of full width, and the cost column removed.

## Open items needing Vin's decision

1. **Version numbering.** Nine stages of user-facing change. Whether this opens a
   minor series or stays on patch releases is Vin's call, per the iron rule on
   version bumps. No version numbers are pinned in this document.
2. **`鐵律升級` deletion rationale is unverified against production.** Vin has already
   decided to drop the feature because he does not use it, so this does not gate
   anything. The supporting claim — that the legacy-text migration is complete — is
   only verified locally: all 88 synced iron-rule files carry frontmatter. The
   production number was **not** checked; there is no SSH access to the OwnMind host
   (deployment goes through v-tag CI/CD) and the
   `GET /api/admin/iron-rules/upgrade-status` endpoint needs admin credentials.
   That endpoint reports `total / skill_md_format / legacy_text`, and the 鐵律升級 tab
   being removed displays exactly those three numbers, so Vin can confirm in seconds
   before Stage 5 deletes it.
