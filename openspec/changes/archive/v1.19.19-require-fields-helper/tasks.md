# v1.19.19 — requireFields helper task list

## Scope

- [x] Write proposal.md
- [ ] Write reproduction test: `tests/require-fields-session-400-format.test.js`
  - All fields missing → returns missing=['tool','model','summary'], received={}
  - Partially missing → returns the correct missing + received containing the sent fields
  - All given → passes
- [ ] Implement `src/utils/require-fields.js`
  - [ ] Signature: `requireFields(body, required, options)`
  - [ ] Treat undefined / null / empty string as missing
  - [ ] For array required fields, treat an empty array as missing
  - [ ] sensitive-key redaction (default redacts password/token/secret/api_key/value, options can add more)
  - [ ] body of null/undefined handled safely
- [ ] Write `tests/require-fields.test.js` (unit test)
  - [ ] body=null
  - [ ] body={}
  - [ ] Partially missing fields
  - [ ] All given
  - [ ] Sensitive-field redaction
  - [ ] Custom sensitiveKeys
  - [ ] Validation of array fields (e.g. chunks)
- [ ] Migrate 6 endpoints
  - [ ] `src/routes/session.js:44`
  - [ ] `src/routes/admin.js:147`
  - [ ] `src/routes/handoff.js:17`
  - [ ] `src/routes/memory.js:899`
  - [ ] `src/routes/memory.js:1688`
  - [ ] `src/routes/secret.js:79` (**value must be redacted**)
  - [ ] `src/routes/usage/pricing.js:62` (unify in passing)
- [ ] Run `node --test` fully green (existing 1827 + new)
- [ ] Version 1.19.18 → 1.19.19 (`package.json` + `package-lock.json`, two places)
- [ ] CHANGELOG.md add the v1.19.19 section
- [ ] FILELIST.md add the v1.19.19 section
- [ ] Trilingual README version updated (zh-TW / en / ja)
- [ ] commit (IR-009 / IR-024)
- [ ] tag v1.19.19 + push origin main + push tag
- [ ] example.com deploy:
  - [ ] `git pull --rebase`
  - [ ] `docker compose build --no-cache api` (IR-018 + IR-023)
  - [ ] `docker compose up -d api`
  - [ ] Check the log to confirm the server is up, no error
- [ ] Post-deploy verification (IR-020):
  - [ ] POST a minimal body to `/api/session`, confirm the new format is returned
  - [ ] MCP `ownmind_log_session` is called normally and unaffected
  - [ ] admin backend login works
- [ ] Write backlog memory (type=project): leg B MCP client-side schema pre-validation
- [ ] `git mv openspec/changes/v1.19.19-... openspec/changes/archive/`
- [ ] Sync the archive path in FILELIST
- [ ] commit archive + push

## Non-tasks

- ❌ Change MCP client schema pre-validation (→ backlog leg B)
- ❌ Change the other 80+ inline 400 validation logic (out of scope)
- ❌ Change existing clients' parsing of error messages (backward-compatible, no change needed)

## Iron-rule checklist

- [x] IR-003 fix bug, write reproduction test first
- [x] IR-004 go through OpenSpec
- [ ] IR-005 no blind edit (Read the full context before migrating each endpoint)
- [ ] IR-008 + IR-026 sync README/FILELIST/CHANGELOG before commit
- [ ] IR-009 + IR-024 commit contributor + no Co-Authored-By
- [ ] IR-018 + IR-023 docker compose build --no-cache
- [ ] IR-020 post-deploy verification
- [ ] IR-031 three version numbers synced
- [ ] IR-032 trilingual README
- [ ] IR-048 run migration before deploy (0 this version)
