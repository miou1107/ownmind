# v1.19.9 — Forgot-password recovery mechanism proposal

## Background: v1.19.8's blind spot

v1.19.8 fixed the first-install experience, but the "admin forgot password" disaster scenario wasn't solved. The current flow:

1. admin forgets password → `/admin/login` fails, there's no "forgot password" link
2. The only option is to SSH into the server and run `UPDATE users SET password_hash = NULL WHERE email = ...`
3. Then set the `SETUP_TOKEN` environment variable, restart, and go through the old `/admin/setup` to reset the password

For technical people it's a hassle; for a non-technical admin it's "the company database is locked out".

## Three-recovery combo (v1.19.9 does all of them)

### Option 1: UI mandatory guidance (prevention beats cure)

- **Strengthen the setup wizard completion page**: after building the first admin, strongly recommend "create a second admin immediately, otherwise forgetting your password will require SSH recovery"
- **Single-admin warning banner in the admin**: when the `admin + super_admin` roles total only 1, show a warning bar at the top of the admin dashboard prompting to create a second one

### Option 2: CLI recovery script (the last line of defense)

- Add `scripts/reset-admin-password.js`
- Interactive: list all super_admins, choose who to reset, confirm, execute
- Action: set the specified user's `password_hash` to NULL, generate a random SETUP_TOKEN, print it
- Guide the user: "set the environment variable `SETUP_TOKEN=<new token>` and restart the server, then open `/admin/setup` to reset the password"
- Write an audit log (action='cli_reset_password')

**Why this counts as recovery rather than a backdoor**: someone who can SSH into the server already has the highest physical privilege and can read the DB and keys directly. The CLI script just downgrades this action from "needing to remember SQL syntax" to "running one command", without lowering the security level.

### Option 3: admin reset of others' passwords (routine recovery)

- Add `POST /api/admin/users/:id/reset-password`
- Permissions: super_admin can reset anyone (admin / user); admin can reset user (cannot reset other admin / super_admin)
- Cannot reset self (use the existing `POST /api/me/change-password`)
- Action: generate a random temporary password (12 alphanumeric chars), set the user's `password_hash` to the new value, `must_change_password=TRUE`
- Return the temporary password once (so the resetter relays it to the other person; the next login forces a change)
- Write an audit log (action='reset_password_by_admin')

## Combined coverage of the three

| Scenario | Which option |
|---|---|
| Hasn't forgotten yet, but only one admin | Option 1 banner reminder, guides creating a second one |
| Admin A forgot, Admin B still around | Option 3 admin resets the other |
| Only one admin, and forgot the password | Option 2 SSH + CLI script |
| All admins forgot | Option 2 SSH + CLI script |
| Cloud SaaS scenario with no SSH access at all | v1.20+ email reset flow (not in v1.19.9 scope) |

## Security considerations

| Risk | Protection mechanism |
|---|---|
| Admin A uses Option 3 to steal another admin's password | Limit super_admin to admin / user, admin can only act on user; audit log records actor + target + time |
| CLI script run by mistake / maliciously | Requires interactive double confirmation, prints the target email and only runs after the user types yes; audit log keeps a record |
| Temporary password leak | Forces `must_change_password=TRUE`, must change on first login; the temporary password is returned only once, not stored anywhere else |
| Brute-forcing the temporary password | 12 random alphanumeric chars = ~71 bits of entropy, sufficient together with authLimiter |

## Things not done

- ❌ Email reset flow (depends on SMTP, left for v1.20+)
- ❌ Recovery code (one-time recovery code) — slightly worse UX, users often forget to save it
- ❌ 2FA / TOTP (multi-factor authentication) — out of scope
- ❌ Self-service forgot-password page — without email integration the only paths are admin or SSH

## Effort estimate

| Item | Line estimate |
|---|---|
| `src/routes/admin.js` add reset-password endpoint | 60-80 |
| `scripts/reset-admin-password.js` | 100-150 |
| `src/public/setup.html` strengthen completion page | 20-30 |
| `src/public/index.html` add banner | 30-50 |
| `tests/admin-reset-password.test.js` | 150-200 |
| `tests/cli-reset-script.test.js` | 80-120 |
| openspec / CHANGELOG / FILELIST / three-language README | 300-400 lines of markdown |
| **Total** | ~1100 lines (half is tests + docs) |

Engineering time: ~3-4 hours.

## Risk checkpoints

- [ ] Run end-to-end: create two super_admins A and B, A resets B's password, B logs in with the temporary password and is forced to change it
- [ ] Run end-to-end: the CLI script resets super_admin A, goes through the SETUP_TOKEN flow to set a new password
- [ ] Confirm admin cannot use Option 3 to reset other admins (403)
- [ ] Confirm reset-password cannot change self (requires going through me/change-password)
- [ ] Confirm the audit log writes all three actions correctly (reset_password_by_admin / cli_reset_password / setup_password)
- [ ] The existing `/admin/setup` + SETUP_TOKEN path isn't broken
- [ ] `npm test` full suite green
