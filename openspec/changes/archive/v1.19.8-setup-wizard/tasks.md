# v1.19.8 — Setup Wizard task list

## v1.19.8 scope

- [ ] Write `src/middleware/first-run-redirect.js` — detect first_run, redirect `/admin/*` → `/setup`
- [ ] Write `src/routes/setup.js` — `GET /api/setup/status` + `POST /api/setup/init`
- [ ] Write `src/public/setup.html` — wizard UI (form + result page)
- [ ] Change `src/index.js` — mount setup route + middleware (order: the first-run middleware must come before the /admin routes)
- [ ] Write `tests/setup-wizard.test.js` — 16 scenario tests
- [ ] Sync the package.json version 1.19.7 → 1.19.8
- [ ] Add the v1.19.8 section to CHANGELOG
- [ ] Add the new files to FILELIST
- [ ] Rewrite the trilingual README FAQ "first install" section: lead with the wizard, demote SETUP_TOKEN to "Advanced / Recovery"

## Risk checkpoints

- [ ] Run end-to-end: empty DB → open browser to `/admin` → confirm redirect to `/setup`
- [ ] Run end-to-end: fill the form → receive api_key → use that key to log in to `/admin/login` successfully
- [ ] Race condition: two concurrent init requests, only one succeeds (run manually or simulate in a test)
- [ ] The existing `/admin/setup` + SETUP_TOKEN path is not broken (run the old setup test and check it is still green)
- [ ] `npm test` fully green
- [ ] Pass `superpowers:requesting-code-review`

## Non-tasks (explicitly not done)

- ❌ Remove the existing `/admin/setup` + `SETUP_TOKEN` (backward compatibility)
- ❌ Upgrade password-strength validation (complexity check left for later)
- ❌ Multi-admin creation flow (the wizard only creates the first super_admin)
- ❌ OAuth / SSO integration (v1.21+ scope)
- ❌ Reset password flow (plan it in v1.20+)
- ❌ install.sh interactive mode (left for v1.19.9)

## Definition of Done

1. On a newly deployed server (empty DB), the user can log in to the admin UI within 5 minutes
2. An existing v1.19.7 deployment upgraded in does not break the SETUP_TOKEN path
3. `npm test` 1595+ fully green (including the newly added setup wizard tests)
4. CHANGELOG / FILELIST / trilingual README are synced
