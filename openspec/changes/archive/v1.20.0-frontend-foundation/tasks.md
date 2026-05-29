# v1.20.0 — Frontend foundation task list

> Scope locked to "foundation"; the actual feature pages are filled in v1.20.1+.

## Stage 1 — frontend build pipeline setup (done)

- [x] `client/package.json`, `client/vite.config.js`, `client/index.html`, `client/.gitignore`
- [x] `client/src/main.jsx`, `client/src/App.jsx`, `client/src/index.css`, `client/src/design-tokens/colors.js`
- [x] Main-repo `package.json` add build:client / dev:client / translate:client
- [x] `Dockerfile` changed to multi-stage build
- [x] `.dockerignore` newly created
- [x] `.gitignore` add frontend-artifact exclusions
- [x] `src/app.js` add the /dashboard route + SPA fallback (keep /admin /me untouched)
- [x] `.claude/launch.json` add a Vite dev server entry
- [x] `npm install` in client/: 85 packages, 0 vulnerabilities
- [x] `vite build`: 212ms, produces 235KB JS (gzip 75KB)
- [x] preview server localhost:5173 renders successfully, zero console errors
- [x] `install.sh` / `install.ps1` add the "run `npm run build:client`" step — **deemed not applicable, skipped**: these two scripts are the user-side client (~/.ownmind/) install scripts, unrelated to server-side dashboard compilation (handled automatically by Docker multi-stage)

## Stage 2 — i18n translation script + mixed Chinese/English lint (completed this turn)

- [x] `client/src/i18n/` full structure (index.js / zh.json / en.json / ja.json / glossary.json / override / README)
- [ ] `translate.mjs` calls the Anthropic Claude Haiku API (temperature=0, prompt carries the glossary)
- [ ] `translate.mjs` manual fallback mode (when no API key, prompt for human translation)
- [ ] `.translate-cache.json` hash comparison to avoid re-translating
- [ ] First translate run, finish translating the 30 keys of zh.json, commit en.json / ja.json
- [ ] Write `scripts/lint-zh-only.js`, add to `npm test`
- [ ] Run lint to confirm 0 fail

## Stage 3 — docs + version bump + release

### Docs
- [ ] CHANGELOG.md add the v1.20.0 section
- [ ] FILELIST.md add the client/ structure
- [ ] Trilingual README version updated

### Version bump
- [ ] `package.json` 1.19.20 → 1.20.0
- [ ] grep SERVER_VERSION synced
- [ ] commit (contributor=Vin, do not add Co-Authored-By)
- [ ] tag v1.20.0
- [ ] push origin main + push tag

### Deploy kkvin.com
- [ ] ssh kkvin.com, git pull, run migration, docker compose build --no-cache, up -d
- [ ] Browser-verify the old /admin/ /me/ still work (coexistence verification)
- [ ] Browser-verify the new /dashboard/ is accessible
- [ ] `curl /api/clients/version` returns 1.20.0

### QA
- [ ] superpowers:verification-before-completion
- [ ] superpowers:requesting-code-review, handle feedback

## Stage 4 — wrap-up

- [ ] Comment on GitHub issue #44 "v1.20.0 done, v1.20.1~4 to follow"
- [ ] `git mv` this folder to archive/
- [ ] Write the v1.20.0 release record into ownmind memory

## Non-tasks (explicitly not done in v1.20.0)

- ❌ Actual content of the Portal / Preference / Admin / Super pages (v1.20.1+)
- ❌ Backend API integration (v1.20.1+)
- ❌ Component splitting (v1.20.1+)
- ❌ Legacy retirement (v1.20.4)
