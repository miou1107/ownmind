# v1.19.18 — Security vulnerability patch task list

## Scope

- [x] Write proposal.md
- [ ] Confirm `npm audit fix --dry-run` preview (done, result: qs 6.15.2, ip-address 10.2.0, express-rate-limit 8.5.2)
- [ ] Run `npm audit fix`
- [ ] Run `npm audit` to confirm 0 vulnerabilities
- [ ] Run `node --test` full suite, must be all green
- [ ] Review the `package.json` + `package-lock.json` diff, confirm only the three packages are bumped
- [ ] Version 1.19.17 → 1.19.18 (`package.json`)
- [ ] SERVER_VERSION synced (grep to confirm all hard-coded locations)
- [ ] CHANGELOG.md add v1.19.18 section
- [ ] FILELIST.md add v1.19.18 section (if new files added)
- [ ] Tri-language README version update (zh-TW / en / ja)
- [ ] commit (IR-009 contributor=Vin, IR-024 no Co-Authored-By)
- [ ] tag v1.19.18 + push origin main + push tag
- [ ] example.com deploy:
  - [ ] ssh example.com
  - [ ] cd /VinService/ownmind && git pull
  - [ ] Run unapplied migrations under db/ (IR-048, should be 0 for this version)
  - [ ] `docker compose build --no-cache` (IR-018 + IR-023)
  - [ ] `docker compose up -d`
  - [ ] Check logs to confirm the server is up, no errors
- [ ] Post-deploy test (IR-020):
  - [ ] Open the admin backend in a browser, login succeeds
  - [ ] `curl https://example.com/ownmind/api/clients/version` returns 1.19.18
  - [ ] `curl POST /api/bug-reports` to confirm query string parsing works after the qs upgrade
- [ ] `git mv openspec/changes/v1.19.18-security-audit-fix openspec/changes/archive/`
- [ ] commit archive, push
- [ ] Close GitHub issue #43 (attach the release commit link)

## Non-tasks

- ❌ Upgrading major version packages (npm audit fix won't do it, this version doesn't intend to)
- ❌ Changing any business logic or adding features
- ❌ Client `~/.ownmind` upgrade (this version is a pure server-side dependency upgrade, does not affect the client)
- ❌ Writing spec.md (pure dependency upgrade, no BDD scenarios to define)

## Iron-rule trigger checklist

- [x] IR-021 git pull before starting (done, already up to date)
- [ ] IR-003 write a reproduction test before fixing a bug —— **skipped, reason**: this version is not a bug fix but an upgrade of known-vulnerable dependencies; the vulnerability reproduction test should be written by the package authors, not OwnMind's responsibility. OwnMind's existing tests + `npm audit` are a double safeguard.
- [ ] IR-008 + IR-026 sync README/FILELIST/CHANGELOG before commit
- [ ] IR-018 + IR-023 deploy with docker compose build --no-cache
- [ ] IR-020 post-deploy browser test
- [ ] IR-031 three-way version sync (package.json / SERVER_VERSION / git tag)
- [ ] IR-032 tri-language README sync
- [ ] IR-048 run migrations before deploy (should be 0 for this version, still confirm)
