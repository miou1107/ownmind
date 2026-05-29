# v1.20.0 — Frontend foundation (laying the "blue" foundation of blue-green coexistence)

- **Author**: Vin
- **Date**: 2026-05-24
- **Status**: in progress
- **Estimated version**: v1.20.0
- **Corresponding GitHub issue**: [#44](https://github.com/miou1107/ownmind/issues/44) (series starting point)
- **Design source**: Gemini Antigravity high-fidelity prototype (`~/.gemini/antigravity/scratch/ownmind-new-ui`) — used only as a UX / visual design reference, not checked into the repo, code not copied verbatim

---

## 0. One-sentence summary

In the main repo, create a `client/` directory, set up the compile/bundle flow, and produce a `/dashboard/` route that is accessible but only shows a "重構中" empty shell, laying the foundation for the subsequent v1.20.1~4 feature releases. **The old `/admin/` and `/me/` are completely untouched.**

---

## 1. Design rationale

### 1.1 Version-control strategy for the v1.20 series (Vin decided 2026-05-24)

v1.20 is the major theme "full backend-frontend rebuild", split per route 3 into 5 patch releases:

| Version | scope |
|---|---|
| **v1.20.0** (this proposal) | foundation (client + build + i18n mechanism + mixed Chinese/English lint) |
| v1.20.1 | dashboard personal edition (Portal 4 pages + Preference 3 pages + API integration) |
| v1.20.2 | dashboard admin edition (Team + Bugs) |
| v1.20.3 | dashboard super-admin edition (Config + Broadcast + Audit) |
| v1.20.4 | retire the old `/admin/` + `/me/` (blue-green switch) |

### 1.2 Why v1.20.0 is pure foundation

- **Shippable immediately**: the foundation is zero-breaking, the old version is completely untouched, it can go through the QA three-step release today
- **Building the foundation first makes later construction easier**: the i18n mechanism + mixed Chinese/English lint are tools every later release needs, build them first
- **Avoid "v1.20.0 never ships"**: lock the scope to the foundation, avoid feature creep

### 1.3 Three core design principles (highest constraint, threading through the whole v1.20 series)

Explicitly issued by Vin before starting on 2026-05-24:

1. **Pure plain Chinese, zero mixed Chinese/English** (CI lint enforced)
2. **Preserve the Gemini prototype's style, copy, and UX touches** (rewrite, do not copy code verbatim)
3. **Long-term maintainable, no hardcoding, no over-engineering** (component splitting + frontend routing + i18n auto-translation + Context state splitting + unified API client + design tokens)

See OwnMind memory id=481 for details.

---

## 2. Scope of this proposal (v1.20.0)

### 2.1 In scope

#### Frontend compile/bundle foundation
- `client/` directory: React 19 + Vite 8 + Tailwind v4 + Recharts + Lucide + react-router-dom
- `client/vite.config.js`: base uses the relative path `./`, output to `../src/public/dashboard/`
- `client/src/main.jsx`: BrowserRouter auto-detects basename
- `client/src/App.jsx`: routing skeleton + placeholders for the three-role guards
- `client/src/index.css`: Tailwind v4 @theme Nordic color palette
- `client/src/design-tokens/colors.js`: JS-side design tokens

#### i18n mechanism (route C: compile-time auto-translation)
- `client/src/i18n/`: `index.js` + `zh.json` single source of truth + `en.json` / `ja.json` compile output + `glossary.json` glossary + `*.override.json` manual override + `README.md`
- `client/src/scripts/translate.mjs`: incremental translation script (calls Anthropic Claude Haiku, temperature=0, prompt carries the glossary)
- First run: translate the initial 30 keys of zh.json, commit en.json / ja.json
- `scripts/lint-zh-only.js`: mixed Chinese/English lint, added to the `npm test` pipeline

#### Main-repo integration
- `package.json`: add the `build:client` / `dev:client` / `translate:client` scripts
- `Dockerfile`: multi-stage build, stage 1 compiles the frontend → stage 2 COPY into `./src/public/dashboard/`
- `.dockerignore`: newly created
- `.gitignore`: add `client/node_modules` / `client/dist` / `src/public/dashboard/`
- `install.sh` / `install.ps1`: add the "run `npm run build:client`" step
- `src/app.js`: add the `/dashboard` route + SPA fallback (**keep the old /admin and /me untouched**)

#### Docs and release
- Trilingual README + CHANGELOG + FILELIST synced
- Version 1.19.20 → 1.20.0 (three places synced)
- Deploy kkvin.com + browser verification

### 2.2 Out of scope (handled in v1.20.1+)

- ❌ Actual content of the Portal 4 pages (v1.20.1)
- ❌ Actual content of the Preference 3 pages (v1.20.1)
- ❌ Admin pages (v1.20.2)
- ❌ Super pages (v1.20.3)
- ❌ Backend API integration (filled in gradually in v1.20.1+)
- ❌ Component splitting (the dashboard's internal structure is filled in v1.20.1+)
- ❌ Legacy retirement (v1.20.4)

---

## 3. Effort

| Item | Estimate |
|---|---|
| client/ directory structure and config | done |
| i18n translation script + lint | half a day |
| docs + version bump + deploy + verification | half a day |
| **Total** | **~1 working day** |

---

## 4. Risks and checkpoints

### Risks
1. **Multi-stage Dockerfile build time**: stage 1 compiling the frontend adds ~30 seconds, the prod build time is acceptable
2. **translate.mjs first run needs an LLM API key**: with no key, it auto-falls back to manual mode and prompts a human to paste into Claude Code to translate
3. **react-router fallback in an nginx prefix environment**: base using the relative path `./` should already handle it, verify in testing

### Pre-deploy must-pass checklist
- [ ] Mixed Chinese/English lint 0 fail
- [ ] `vite build` produces dist and serves successfully
- [ ] localhost:5173 renders successfully, zero console errors
- [ ] `npm audit` 0 vulnerabilities
- [ ] The existing 1827+ tests all green
- [ ] Trilingual README version synced to v1.20.0
- [ ] db/ migration run
- [ ] Dockerfile COPY paths correct

---

## 5. Post-upgrade follow-up

- Close GitHub issue #44 with the comment "v1.20.0 foundation done, v1.20.1~4 to follow" (do not close the issue, only close it when the whole v1.20.4 retirement is done)
- Move this folder to `openspec/changes/archive/v1.20.0-frontend-foundation/`
- Kick off the next release v1.20.1: expand the stub in `openspec/changes/v1.20.1-portal-pages/` into a full proposal
