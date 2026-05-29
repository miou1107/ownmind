# v1.20.1 — Dashboard personal edition task list

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement each subtask one by one. Each subtask follows the TDD flow "write test → run test to confirm failure → write implementation → run test to confirm pass → commit".

**Goal**: convert the 7 personal-edition pages (Portal 4 + Preference 3) + the login page from PlaceholderPage into real implementations connected to the backend API.

**Architecture**:
- Frontend: React 19 + Vite 8 + Tailwind v4 + react-router-dom v7 + recharts + lucide-react
- Backend: Express 5 existing routes (`src/routes/*.js`)
- API client: new `client/src/api/` unifying fetch + Bearer header + error handling
- Auth: localStorage stores api_key, route guard redirects to `/login` when not logged in

**Tech Stack**: node --test (backend), lint:zh-only (frontend Chinese-residue check), preview_* tools (manual UI verification), Playwright (introduced only in step 4)

---

## High-level stages

- [x] **Step 1**: split shared components (Sidebar / TopBar / FilterBar / Footer / Modal / RoleBadge / StatCard / Layout) — commit `6cbaf52`
- [x] **Step 2**: i18n LocaleContext (global state-management tool for language switching) + trilingual files (zh/en/ja) + auto-translation script — commit `6cbaf52`
- [ ] **Step 3**: implement 11 subtasks (3.0~3.10) — convert PlaceholderPage into real pages + connect the API
- [ ] **Step 4**: Playwright e2e tests (login + view usage + accept handoff)
- [ ] **Step 5**: docs (README/FILELIST/CHANGELOG) + bump to v1.20.1 + deploy + browser verification

## Pre-kickoff confirmation (done)

- [x] Confirm actual operation after the v1.20.0 release (deploy succeeded, Dockerfile path fixed)
- [x] Compare against the prototype UX: treat the old me.html as the de facto spec (the existing GET /api/me/report shape fully covers the usage page's needs)
- [x] List the API endpoints to add this version: missing `PUT /api/me/profile` (everything else is present)

---

## Step 3 subtask breakdown

### Subtask 3.0: API client base (frontend fetch wrapper)

**Files:**
- Create: `client/src/api/client.js` — fetch wrapper (auto-attaches `Authorization: Bearer <api_key>`, JSON parse, error handling)
- Create: `client/src/api/index.js` — outward export
- Create: `client/src/api/README.md` — usage notes
- Create: `client/src/api/auth.js` — `getApiKey()` / `setApiKey()` / `clearApiKey()` (localStorage)

**Acceptance:**
- [ ] `apiGet('/api/me/profile')` auto-attaches the Bearer header, returns `{ ok, data, error }`
- [ ] `apiPost('/api/me/login', { email, password })` does not attach the Bearer header (whitelist)
- [ ] 401 auto-clears localStorage and returns `{ ok: false, error: 'unauthorized' }` (no redirect, leave it to the caller)
- [ ] lint:zh-only passes (no Chinese characters allowed in code, comments may be Chinese)

**Why no test:** the frontend has no test framework; rely on lint + manual browser testing (verify in passing when pages from 3.2 onward connect the API).

---

### Subtask 3.1: add the backend `PUT /api/me/profile` endpoint

**Files:**
- Modify: `src/routes/me.js` — add `router.put('/profile', ...)` after `GET /profile`
- Create: `tests/me-profile-put.test.js` — integration test (mini express app + fetch)

**Acceptance:**
- [ ] `PUT /profile { name }` updates name, returns `{ id, name, email, role, created_at, must_change_password }`
- [ ] name is required, cannot be an empty string after trim, length 1-100
- [ ] **Cannot change email / role** (even if the body carries these two, ignore them)
- [ ] No api_key → 401
- [ ] DB update failure → 500, log logger.error
- [ ] `npm test` fully green

**TDD steps:**
1. Write 4 failing tests (route exists, name required, valid update, ignore email/role)
2. Run `node --test tests/me-profile-put.test.js` to confirm FAIL
3. Add the PUT handler in me.js
4. Re-run to confirm PASS
5. Run the whole `npm test` to confirm no other tests are broken
6. Commit

---

### Subtask 3.2: Portal `/portal/usage` usage analysis page ✅

**Files:**
- Create: `client/src/pages/Portal/UsagePage.jsx` — main page
- Create: `client/src/pages/Portal/UsageMine.jsx` — personal section
- Create: `client/src/pages/Portal/UsageTeam.jsx` — team section (with trend chart)
- Create: `client/src/pages/Portal/UsageProjects.jsx` — projects section
- Modify: `client/src/App.jsx` — switch the `/portal/usage` route from PlaceholderPage to UsagePage
- Modify: `client/src/i18n/zh.json`, `en.json`, `ja.json` — add page strings
- Reuse: `StatCard`, `FilterBar` (existing shared components)

**API:** `GET /api/me/report?range=14d` or `?start=YYYY-MM-DD&end=YYYY-MM-DD`

**Acceptance:**
- [x] Three tabs: personal / team / projects
- [x] Switch range (7d/14d/30d/all) — implemented as a standalone small component "range switcher bar", not FilterBar (the interface doesn't match)
- [x] Trend chart uses recharts (daily line / range bar / weekday bar)
- [x] Loading state, error state, empty state are all handled
- [x] Browser manual mock-fetch verification of the three tabs + Modal flow, 0 console.error

---

### Subtask 3.3: Portal `/portal/project-history` project history page

**Files:**
- Create: `client/src/pages/Portal/ProjectHistoryPage.jsx`
- Modify: `client/src/App.jsx`, the three i18n files

**API:** `GET /api/memory?type=project`

**Acceptance:**
- [ ] List view, each project shows title, updated_at, description (truncated)
- [ ] Click a row to open a Modal and see the full content
- [ ] FilterBar searches title

---

### Subtask 3.4: Portal `/portal/handoffs` work handoff page

**Files:**
- Create: `client/src/pages/Portal/HandoffsPage.jsx`
- Create: `client/src/pages/Portal/HandoffCard.jsx` — single handoff card
- Modify: `client/src/App.jsx`, the three i18n files

**API:** `GET /api/handoff/pending` (list pending) + `PUT /api/handoff/:id/accept` (accept)

**Acceptance:**
- [ ] Pending handoff list + accept button
- [ ] After a successful accept, remove from the list (without reloading the whole page)
- [ ] An empty list shows "沒有待處理交接"

---

### Subtask 3.5: Portal `/portal/reports` report records page

**Files:**
- Create: `client/src/pages/Portal/ReportsPage.jsx`
- Modify: `client/src/App.jsx`, the three i18n files

**API:** `GET /api/bug-reports` (the personal "own" filter is auto-applied by the backend) + `GET /api/bug-reports/:id`

**Acceptance:**
- [ ] List: time, title, status (待修 / 已修)
- [ ] Click a row to open a Modal showing the full content

---

### Subtask 3.6: Preference `/preference/profile` personal profile page

**Files:**
- Create: `client/src/pages/Preference/ProfilePage.jsx`
- Modify: `client/src/App.jsx`, the three i18n files
- Depends on: 3.1 (PUT endpoint)

**API:** `GET /api/me/profile` (load) + `PUT /api/me/profile` (save)

**Acceptance:**
- [ ] Show email / role / created_at (read-only) + name (editable)
- [ ] Save success toast, failure toast
- [ ] name-required validation is blocked on the frontend first

---

### Subtask 3.7: Preference `/preference/security` account/password change page

**Files:**
- Create: `client/src/pages/Preference/SecurityPage.jsx`
- Modify: `client/src/App.jsx`, the three i18n files

**API:** `POST /api/me/change-password`

**Acceptance:**
- [ ] Three fields: old password / new password / new password confirmation
- [ ] New password length ≥ 8, new differs from old (blocked on the frontend first)
- [ ] Backend rejection (old password wrong) → show error message
- [ ] On success, clear the form + toast

---

### Subtask 3.8: Preference `/preference/vault` secret management page

**Files:**
- Create: `client/src/pages/Preference/VaultPage.jsx`
- Create: `client/src/pages/Preference/SecretRow.jsx`
- Modify: `client/src/App.jsx`, the three i18n files

**API:** `GET /api/secret`, `POST /api/secret`, `PUT /api/secret/:key`, `DELETE /api/secret/:key`

**Acceptance:**
- [ ] List all secret keys (do not show the value; only fetch + show after clicking "顯示")
- [ ] Add / edit / delete (red button + confirmation dialog — IR-046)
- [ ] preview_click tests the CRUD flow

---

### Subtask 3.9: login page `/login`

**Files:**
- Create: `client/src/pages/LoginPage.jsx`
- Modify: `client/src/App.jsx` — add the `/login` route (not wrapped in Layout)

**API:** `POST /api/me/login { email, password }` → get `{ api_key, must_change_password }` → store in localStorage → redirect to `/portal/usage` (if must_change_password=true, redirect to `/preference/security`)

**Acceptance:**
- [ ] Email + password fields
- [ ] Errors show the error message returned by the backend
- [ ] Redirect logic after success is correct
- [ ] preview_fill + preview_click run the flow successfully

---

### Subtask 3.10: route guard (redirect to `/login` when not logged in)

**Files:**
- Create: `client/src/components/common/RequireAuth.jsx`
- Modify: `client/src/App.jsx` — wrap all `/portal/*`, `/preference/*`, `/admin/*`, `/super/*` routes with RequireAuth
- Modify: `client/src/api/client.js` — on 401, trigger an event or directly `window.location.href='/login'`

**Acceptance:**
- [ ] Visiting any `/portal/*` while not logged in → immediately redirect to `/login`
- [ ] After login, redirect back to the page originally intended (state records the from path)
- [ ] api_key expired (401) → auto-redirect to `/login`

---

## Subtask dependency graph

```
3.0 (API client base)
 ├─→ 3.2 ~ 3.8 (all seven pages depend on it)
 ├─→ 3.9 (login page)
 └─→ 3.10 (route guard)

3.1 (add PUT) ─→ 3.6 (personal profile page)

3.9 (login page) ─→ 3.10 (route guard) — but 3.10 can follow immediately after 3.9 is done
```

## Planned order

1. **3.0** → 2. **3.1** → 3. **3.9** → 4. **3.10** → 5. **3.6** → 6. **3.7** → 7. **3.2** (most complex) → 8. **3.3** → 9. **3.4** → 10. **3.5** → 11. **3.8**

(The first 4 are the foundation; once done the other 7 pages can be done in parallel or chained quickly)

---

## Step 4: e2e tests

- Introduce Playwright (decide the concrete setup when v1.20.1 kicks off)
- At least 3 scenarios: login / view usage / accept handoff

## Step 5: release

- README / FILELIST / CHANGELOG updates (IR-020, IR-121)
- README trilingual sync (IR-131)
- package.json / SERVER_VERSION / git tag — three version numbers synced (IR-130)
- Browser verification of the OwnMind homepage after deploy (IR-058)
- archive the openspec change to openspec/changes/archive/
