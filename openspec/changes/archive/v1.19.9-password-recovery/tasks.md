# v1.19.9 — Forgot-password recovery task list

## v1.19.9 scope

### Option 3: admin reset of others' passwords
- [ ] Add `POST /api/admin/users/:id/reset-password` (src/routes/admin.js)
- [ ] Write a helper to generate a 12-char random temporary password (avoiding confusable characters)
- [ ] Write tests/admin-reset-password.test.js (scenarios 1-7, ~10 cases)

### Option 2: CLI recovery script
- [ ] Write `scripts/reset-admin-password.js`
- [ ] List super_admins / interactive selection / double confirmation / write audit log
- [ ] Write tests/cli-reset-script.test.js (with mock db, simulated stdin, scenarios 9-12)

### Option 1: UI mandatory guidance
- [ ] Change src/public/setup.html, add a warning box to the success page (scenario 13)
- [ ] Change src/public/index.html, add a single-admin banner (scenarios 14, 15)
- [ ] Provide GET /api/admin/health or add a single_admin_warning flag to the login response

### Docs + sync
- [ ] package.json 1.19.8 → 1.19.9
- [ ] CHANGELOG add v1.19.9 section
- [ ] FILELIST add new files
- [ ] Add a "what to do if you forget your password" FAQ entry to the three-language README (placed below the "first install" section)
- [ ] npm test full suite green
- [ ] Run superpowers:requesting-code-review

## Risk checkpoints

- [ ] Run end-to-end: create two admins A and B, A resets B's password, B logs in with the temporary password and is forced to change it
- [ ] Run end-to-end: the CLI script resets a single super_admin, goes through SETUP_TOKEN to set a new password
- [ ] admin cannot reset other admins (403)
- [ ] reset-password endpoint cannot change self (400)
- [ ] The audit log writes all three actions correctly (reset_password_by_admin / cli_reset_password / setup_password)
- [ ] The existing /admin/setup + SETUP_TOKEN path isn't broken
- [ ] When the CLI script can't connect to the DB it doesn't mistakenly change any user

## Non-tasks (explicitly not done)

- ❌ Email reset flow (depends on SMTP, left for v1.20+)
- ❌ Recovery code (one-time recovery code)
- ❌ 2FA / TOTP
- ❌ Self-service "forgot password" page

## Definition of done

1. Any admin who forgets their password can be recovered by another admin within 5 minutes (scenarios 1-2)
2. The sole admin forgetting their password can be recovered via the CLI script + SETUP_TOKEN
3. In the single-admin state, the admin clearly prompts to create a second one
4. `npm test` 1622+ all green (including the newly added tests)
5. Passes code review
