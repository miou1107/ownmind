# v1.19.10 — Security hardening: randomize default passwords + config best practices

## Background

Before v1.19.9 OwnMind had a few code patterns related to sensitive data that could be improved:

1. `.mcp.json` contained the literal `OWNMIND_API_KEY` value — a publicly shared config file should not contain a loginable key
2. `src/routes/admin.js` and `src/jobs/seed-default-passwords.js` both used a fixed string as the default password for all users — even with the `must_change_password=TRUE` flag forcing a change on next login, this still violates the "do not share credentials" best practice

This change also writes that layer of protection into the IR-002 detector, to prevent accidentally committing similar literal strings in the future.

## Improvement scope

### 1. Change default passwords to "randomly generated per user"

- Add `shared/random-password.js` providing the `generateRandomPassword(len)` pure function
  - The rules follow v1.19.9's `generateTempPassword`: 12 chars, including upper/lowercase + digits, avoiding confusing chars 0/O/I/l/1, with `crypto.randomBytes` randomness
- `src/routes/admin.js` switches to this function when creating a user (replacing the fixed string)
- `src/jobs/seed-default-passwords.js` changes startup password backfill to generate a random password per record, displayed once in the server log
- Aligned with the v1.19.9 backend reset-password behavior, logic unified

### 2. Change `.mcp.json` to a placeholder + harden `.gitignore`

- Change the literal `OWNMIND_API_KEY` value to `__SET_VIA_LOCAL_CREDENTIALS_OR_ENV__`
- Add comments explaining: when running locally, get the key from `~/.ownmind/credentials`, or create your own `.mcp.local.json` (already added to `.gitignore`)
- Add `.gitignore` rules: `.mcp.local.json` / `credentials*` / `*.pem` / `*.key` / `.env.local` / `.env.production`

### 3. Secret detector detects new patterns

- `src/utils/secret-detect.js` (introduced in v1.19.7, used by the IR-002 pre-commit hook) adds two regexes:
  - `ownmind_predefined_key`: catches the `(vin-)?ownmind-(admin|super|user|api)-*` predefined key format
  - `default_password_literal`: catches the `Password\d{8,}` generic default password pattern
- 9 new unit tests (including hits and edge cases, avoiding false positives on the ordinary word `password`)

## Security considerations

| Item | Protection mechanism |
|---|---|
| Risk of the admin-visible temporary password log leaking | the server log is sensitive info; the deployment environment's log collector should be careful (recommend stdout only, not sent to the cloud) |
| Pre-upgrade old deployments still run the fixed password | after upgrading to v1.19.10 and restarting, `seedDefaultPasswords` does not touch users that already have a `password_hash`; newly created users all go through the new logic |
| Whether the admin of an existing deployment should reset its password | this is the deployer's call; the v1.19.9 backend reset-password and the CLI rescue script both support it, can be done optionally |

## Out of scope

- ❌ Touching the DB schema (reuse the existing `users.must_change_password` and `password_hash`)
- ❌ Rewriting git history (a force-push would break the local state of everyone who has cloned the repo, cost outweighs benefit)
- ❌ Switching the git provider or secret management service (out of scope)

## Effort estimate

| Item | Lines |
|---|---|
| `shared/random-password.js` (extracted from v1.19.9) | 50-70 |
| `.mcp.json` change to placeholder | 5 lines |
| `admin.js` switch to shared module | 15 lines changed |
| `seed-default-passwords.js` change to per-user random | 30-40 |
| `.gitignore` add rules | 12 lines |
| `secret-detect.js` add 2 regexes | 12 lines |
| `secret-detect-unit.test.js` add 9 cases | 50 lines |
| Tri-language README + CHANGELOG + FILELIST | 200 lines |
| openspec | 150 lines |
| **Total** | About 500 lines |

Engineering time: about 1.5-2 hours.

## Risk checkpoints

- [ ] `npm test` full suite green (including the 9 new cases)
- [ ] `seedDefaultPasswords` startup behavior is backward compatible (still backfills users with `password_hash IS NULL`, just with a different password per person)
- [ ] When admin creates a user without specifying a password, the response's `default_password` is a random value unique to that user
- [ ] The IR-002 pre-commit hook blocks commits containing the `ownmind-admin-*` or `Password\d{8,}` string
- [ ] Existing features (admin / setup / password-reset / seed job) all run
