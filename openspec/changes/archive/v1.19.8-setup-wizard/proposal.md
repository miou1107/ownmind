# v1.19.8 — First-install Setup Wizard Proposal

## Background: chicken-and-egg problem

Before OwnMind v1.19.7, new users hit a deadlock right after first-deploying the server:

1. `db/001_init.sql` only creates the schema, it does not seed any account
2. Try the admin UI → `/admin/login` finds no super_admin record, returns "wrong account or password"
3. Try to recover via the `/admin/setup` endpoint → must first do two things:
   - Set the env var `SETUP_TOKEN` and restart the server
   - Manually SQL-INSERT a super_admin record with `password_hash IS NULL`
4. Try the client install.sh → must first have an API key, but an API key can only be produced after an existing super_admin creates a user in the backend

**Result**: a new user deploys the server, opens the admin UI in a browser, gets stuck, and spends 30+ minutes on average just figuring out the recovery path. A terrible onboarding experience that seriously blocks product adoption.

## Rejected approaches

After a full design discussion (Codex Rescue evaluation during the v1.19.7 README rewrite), the following approaches are not adopted:

- **A. Auto-seed a random super_admin**: the password gets written to a log/file, and a leaked log gives away the super_admin. "Users don't know where to find the password" is also a UX problem
- **D. DEV_MODE default admin/admin**: if the production environment accidentally starts with `OWNMIND_DEV_MODE=1` it's game over, and the protection mechanism is more complex than the wizard

## Adopted approach: Setup Wizard web page

### Core logic

1. **Add first-run detection middleware**: before every `/admin/*` request, run `SELECT COUNT(*) FROM users WHERE role IN ('admin', 'super_admin')`
2. **When count = 0, auto-redirect to `/setup`** — the user opens the admin UI and is automatically taken into the wizard, with zero documentation-reading cost
3. **`/setup` is a plain HTML page** — the form collects email + password + password confirmation
4. **`POST /api/setup/init` endpoint**:
   - Internally double-checks that the users table is empty (prevents a race condition)
   - Creates the first super_admin (hashes the password, auto-generates an api_key UUID)
   - Writes an audit log (actor_user_id uses system_user_id)
   - Returns the newly created api_key so the user can copy it into client install.sh
5. **The endpoint auto-disables once setup is done** — because first-run detection now returns false, any later POST always gets 403

### Coexistence strategy with the existing SETUP_TOKEN

The existing `/admin/setup` endpoint is not removed, but is repositioned as an "emergency recovery channel":

- **users table is empty** → goes through the new setup wizard (no SETUP_TOKEN needed, zero friction)
- **users table has a super_admin but password_hash IS NULL** (the scenario of importing an account externally) → goes through the old `/admin/setup`, still requires SETUP_TOKEN
- **users table has a super_admin with a password already set, but the admin forgot the password** → goes through manual SQL reset + the old setup token path

The README and FAQ demote the description of the old path to an "Advanced / Recovery" section, and lead with the wizard.

## Security considerations

| Risk | Protection mechanism |
|---|---|
| Race condition (two requests both see first_run=true) | DB transaction + `SELECT ... FOR UPDATE`, or insert-first + check-after + rollback on failure |
| Wizard endpoint stays permanently open and gets misused | Strict first-run check; once the users table has an admin it is permanently closed with 403 |
| Password too weak | Enforce a minimum length of 8; a complexity check can be added later (not in v1.19.8 scope) |
| The /setup page gets crawled by search engines | Add `<meta name="robots" content="noindex">` |
| Rate limit | Cover it with the existing rate limit middleware (e.g. src/middleware/auth-rate-limit.js) |
| HTTPS | Reuse the existing setup, nothing extra. The deployment docs should recommend putting HTTPS in front before running setup |

## Out of scope

- ❌ Do not remove the existing `/admin/setup` + `SETUP_TOKEN` (backward compatibility)
- ❌ Do not upgrade password-strength validation (keep the 8-char minimum, leave complexity for later)
- ❌ Do not build a multi-admin creation flow (the wizard only creates the first super_admin, others are created in the backend)
- ❌ Do not build OAuth / SSO (that is v1.21+ scope)
- ❌ Do not build a reset-password flow (plan it in v1.20+, forgot-password still goes through manual SQL)
- ❌ Do not change install.sh interactive mode (Codex's evaluated approach C is left for v1.19.9)

## Effort estimate

| Item | Estimated lines |
|---|---|
| `src/routes/setup.js` | 80-120 |
| `src/middleware/first-run-redirect.js` | 30-50 |
| `src/public/setup.html` | 120-180 |
| `src/index.js` mounting | 5-10 |
| `tests/setup-wizard.test.js` | 200-300 (8-12 cases) |
| openspec change | ~300 lines of markdown |
| CHANGELOG / FILELIST / README | ~100 lines |
| **Total** | ~1000 lines (half is tests + docs) |

Actual engineering can be done in about 3-5 hours (including review fixes).

## Risk checkpoints

- [ ] After creating the first admin, immediately try `/api/setup/init` once and confirm it returns 403
- [ ] Run end-to-end with an empty DB: open the browser to `/admin` → should be redirected to `/setup`
- [ ] Race condition test: two concurrent init requests, only one can succeed
- [ ] The existing `/admin/setup` + `SETUP_TOKEN` path still works normally (does not break existing deployments)
