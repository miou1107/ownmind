# v1.19.10 — Hotfix task list

## Scope

### Code fixes
- [x] `.mcp.json`: change `OWNMIND_API_KEY` to the `__SET_ME_VIA_LOCAL_OVERRIDE__` placeholder + add comments
- [x] `src/routes/admin.js`: remove the fixed `DEFAULT_USER_PASSWORD` value, switch to `generateTempPassword` (extracted from v1.19.9 into `shared/random-password.js`)
- [x] `src/jobs/seed-default-passwords.js`: generate a random password per user, no longer sharing a fixed value
- [x] Add `shared/random-password.js`: extract v1.19.9's `generateTempPassword` from `admin-password-reset.js` for shared use across multiple places
- [x] `.gitignore`: add `.mcp.json` and `.env*` and `credentials*` and `*.pem`

### Detector hardening
- [x] `src/utils/secret-detect.js`: add the two regexes `vin-ownmind-*` and `Password\d{8,}`
- [x] `tests/secret-detect-unit.test.js`: add tests for the new patterns

### Docs sync
- [x] package.json 1.19.9 → 1.19.10
- [x] CHANGELOG add v1.19.10 section (neutral security hardening description)
- [x] FILELIST
- [x] Tri-language README version info update (no separate user-facing FAQ, this is an internal best-practice hardening)

### Verification
- [x] `npm test` full suite green
- [x] Run `superpowers:requesting-code-review`
- [x] commit

## Risk checkpoints

- [x] After the DB-side SQL (Vin manually) is run, the new api_key has been updated to the local `.mcp.json` and `~/.ownmind/credentials`
- [x] After the `seedDefaultPasswords` change, if there are `password_hash IS NULL` users at server startup, it prints an individual random password per person to the server log (one-time)
- [x] When admin creates a user without specifying a password, the response's `default_password` is a random value unique to that user
- [x] The IR-002 pre-commit hook blocks the next commit containing the `vin-ownmind-` or `Password\d{8,}` string

## Non-tasks

- ❌ git history cleanup (key already rotated, old history can be kept as an event record)
- ❌ Switching the git provider
- ❌ OAuth / SSO (v1.21+)
