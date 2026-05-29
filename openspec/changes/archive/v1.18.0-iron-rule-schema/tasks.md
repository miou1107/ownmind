# v1.18.0 — Tasks

Execution checklist. Forced order: dependencies → backend lint → backend sync → frontend upgrade helper → integration → verification → three-doc sync → review → commit → deploy.

Can split into 3 commits (v1.18.0-rc1 / rc2 / rc3) → integrate into v1.18.0.

---

## 0. Prerequisites (awaiting Vin's decisions on remaining 6 items)

- [ ] **Decision #1** Confirm migration strategy: manual + AI-assisted in batches (via Web UI)
- [ ] **Decision #2** Confirm lint description warning < 50 chars (not reject)
- [ ] **Decision #3** Confirm introducing `js-yaml` (~50KB)
- [ ] **Decision #4** Confirm adding the `previous_content` backup column
- [ ] **Decision #5** Confirm cross-tool sync scope (all 6 / only Claude Code + Codex)
- [ ] **Decision #6** Confirm sync conflict: DB always wins

---

## 1. Dependencies + tooling (start of rc1)

- [ ] `npm install js-yaml --save` into root package.json
- [ ] New file `src/utils/iron-rule-frontmatter.js`:
  - [ ] `detectFrontmatter(content)` → `{has: bool, frontmatter?: object, body?: string}`
  - [ ] parse with `js-yaml.load`, catch parse errors
  - [ ] tests/iron-rule-frontmatter.test.js (10+ cases: valid / missing trailer / invalid YAML / plain text / empty frontmatter)

---

## 2. Schema lint (rc1)

- [ ] Edit `src/utils/iron-rule-quality.js`:
  - [ ] Refactor `lintIronRule(rule)` to add frontmatter detection at the start
  - [ ] New `lintSkillMdRule(rule, frontmatter, body)` — runs spec.md §1.3 S1-S9
  - [ ] No frontmatter → original v1.17.94 path (rules #1-#7, unchanged)
  - [ ] return shape adds `format: 'skill_md' | 'legacy_text'` + `warnings: string[]` (warnings don't count as errors)
- [ ] tests/iron-rule-quality-skill-md.test.js (20+ cases, covering S1-S9 + warning + valid)
- [ ] tests/iron-rule-quality.test.js — run a snapshot of the existing 35 iron rules to guarantee backward compatibility (regression)

---

## 3. MCP API accepts SKILL.md (rc1)

- [ ] Edit `src/routes/memory.js` POST /memory + PUT /memory/:id:
  - [ ] Use the new `lintIronRule` return shape
  - [ ] Add `format` field to the response
  - [ ] Fill `previous_content` when writing to DB (if Decision #4 = yes)
- [ ] tests/memory-iron-rule-skill-md.test.js (POST + PUT, SKILL.md path / legacy fallback path)

---

## 4. DB migration (only if Decision #4 = yes)

- [ ] New file `db/013_iron_rule_previous_content.sql`:
  ```sql
  ALTER TABLE memories ADD COLUMN IF NOT EXISTS previous_content TEXT;
  ```
- [ ] update CHANGELOG migration steps

---

## 5. Commit rc1

- [ ] `npm test` all green (≥ 1080: 1054 + 30+ new)
- [ ] code review (independent agent)
- [ ] commit + push (don't deploy, ship all together at rc3)

---

## 6. Sync hook backend (rc2)

### 6.0 Conditional sync — new lightweight endpoint (backend)

- [ ] Edit `src/routes/memory.js`: add `GET /api/memory/sync-token`
  - [ ] auth middleware same as other endpoints
  - [ ] internally call the existing `generateSyncToken(req.user.id)` (helper already exists)
  - [ ] return `{ sync_token: 'a1a785218482' }`
  - [ ] **don't query any memory data** (lightweight, < 100 bytes response)
- [ ] tests/sync-token-endpoint.test.js
  - [ ] auth ok → returns sync_token
  - [ ] auth fail → 401
  - [ ] response < 100 bytes
  - [ ] after writing an iron rule, calling again → sync_token changes
  - [ ] two calls by the same user are idempotent

### 6.1 File system sync helper

- [ ] New file `src/utils/iron-rule-sync.js`:
  - [ ] `buildBigSkillMd(rules)` → builds `~/.claude/skills/ownmind-iron-rules/SKILL.md` content
  - [ ] `buildReferenceFile(rule)` → reference file content for a single iron rule
  - [ ] `syncToFilesystem(rules, target)` — target is a platform enum (claude / cursor / codex / ...)
  - [ ] write only if the directory is detected (reuse install.sh:300 pattern)
- [ ] tests/iron-rule-sync.test.js (mock fs, verify each target writes correctly / doesn't write / conflict detection)

---

## 7. MCP client triggers sync (rc2)

- [ ] Edit `mcp/index.js`:
  - [ ] after `ownmind_save` / `ownmind_update` successfully writes an iron rule, call the new helper `syncIronRulesLocal()`
  - [ ] the sync helper uses lib/sync-iron-rules.js (shared between MCP and the SessionStart hook)
- [ ] New file `mcp/lib/sync-iron-rules.js`:
  - [ ] `syncIronRulesLocal(apiUrl, apiKey)` — pull the DB iron_rule list, run syncToFilesystem
  - [ ] on failure, silently log a warning, don't throw
- [ ] tests/sync-iron-rules.test.js

---

## 8. SessionStart hook conditional sync (rc2) — core

- [ ] New file `hooks/lib/conditional-sync.js`:
  - [ ] `shouldRefreshCache(localCache, serverSyncToken)` → bool
    - returns true if: cache missing / cache.sync_token !== server / cache.saved_at > 24hr
  - [ ] `fetchSyncTokenLight(apiUrl, apiKey)` → server sync_token (~50 bytes, 3s timeout)
  - [ ] `runConditionalSync(apiUrl, apiKey, cachePath)`
    - 1. read local cache
    - 2. if 24hr expired → full init path
    - 3. else GET /sync-token, compare
    - 4. token same → no-op, return cache
    - 5. token different → GET /init?compact=true, write new cache, return new data
    - 6. on failure, fallback to local cache
- [ ] Edit `hooks/lib/sync-memory-files.js`:
  - [ ] run `runConditionalSync` at the start, get the iron rule list
  - [ ] only run `syncIronRulesLocal` to rewrite local skill files if iron rules changed
  - [ ] unchanged → skip entirely, don't hit the cloud init endpoint
- [ ] tests/conditional-sync.test.js
  - [ ] sync_token same → don't hit init endpoint (mock server)
  - [ ] sync_token different → hit init + write new cache
  - [ ] cache 24hr expired → force init
  - [ ] sync-token endpoint fails → fallback to init
  - [ ] init endpoint fails → fallback to local cache
- [ ] tests/session-start-iron-rule-sync.test.js
  - [ ] iron rules unchanged → SessionStart skips skill file rewrite
  - [ ] iron rules changed → SessionStart rewrites skill files

---

## 9. Cross-tool sync paths (Decision #5 scope)

- [ ] Add platform handlers in `src/utils/iron-rule-sync.js`:
  - [ ] Claude Code: full skill folder
  - [ ] Cursor: inline single file (if Decision #5 = full)
  - [ ] Antigravity: same as Cursor
  - [ ] Codex: AGENTS.md block append (marker `<!-- ownmind-iron-rules -->`)
  - [ ] OpenCode: same as Codex
  - [ ] Windsurf: same as Cursor
  - [ ] Gemini: same as Codex
- [ ] install.sh / install.ps1:
  - [ ] run syncIronRulesLocal once on install, initialize all directories
- [ ] tests/cross-tool-sync.test.js (mock fs, verify each tool is judged independently)

---

## 10. Commit rc2

- [ ] `npm test` all green (≥ 1110)
- [ ] code review
- [ ] commit + push

---

## 11. Upgrade helper backend (rc3)

- [ ] Edit `src/routes/admin.js` (or new file `src/routes/admin-iron-rule-upgrade.js`):
  - [ ] GET `/api/admin/iron-rules/upgrade-status`
  - [ ] POST `/api/admin/iron-rules/:id/suggest-skill-md` (call LLM API)
  - [ ] PUT `/api/admin/iron-rules/:id/upgrade` (lint + write DB + trigger sync)
- [ ] LLM suggest helper:
  - [ ] use OWNMIND_SUGGEST_API_KEY env, if absent → endpoint disabled
  - [ ] prompt template: "Rewrite this iron_rule into SKILL.md format..."
  - [ ] server runs lint on the response; on fail, still return it to the frontend with warnings
- [ ] tests/admin-iron-rule-upgrade.test.js (fake LLM stub)

---

## 12. Upgrade helper frontend (rc3)

- [ ] New admin page `/admin/iron-rule-upgrade` (see admin static folder):
  - [ ] List view: 35 rules + format tag
  - [ ] Per-row buttons: [Suggest] [Edit] [Skip]
  - [ ] Diff view modal: left original / right proposed, editable textarea
  - [ ] [Confirm & Save] PUTs it up
- [ ] UI test (puppeteer / playwright if an existing framework, otherwise manual)

---

## 13. Docs + three-doc sync (rc3)

- [ ] CHANGELOG.md v1.18.0 entry
- [ ] README.md / docs/README.zh-TW.md / docs/README.ja.md:
  - [ ] version 1.17.99 → 1.18.0
  - [ ] add section "Iron rule SKILL.md standardization + local sync"
- [ ] FILELIST.md lists the new files

---

## 14. Commit rc3 + integration

- [ ] `npm test` all green (≥ 1140)
- [ ] code review
- [ ] commit
- [ ] tag v1.18.0
- [ ] push

---

## 15. Deploy + verification

- [ ] SSH prod:
  - [ ] git pull
  - [ ] migration (if Decision #4 = yes): `docker compose exec -T db psql ... < db/013_iron_rule_previous_content.sql`
  - [ ] `docker compose build --no-cache api && docker compose up -d api`
  - [ ] verify version → 1.18.0
- [ ] Browser test:
  - [ ] admin opens /admin/iron-rule-upgrade, see the list of 35 rules
  - [ ] select one, click [Suggest], see the diff
  - [ ] [Confirm] one, see the DB write + format='skill_md'
  - [ ] open a new Claude Code session, see ~/.claude/skills/ownmind-iron-rules/ created
  - [ ] when the AI triggers an iron rule, check whether it pulls details from the ownmind-iron-rules skill

---

## 16. Wrap-up

- [ ] OpenSpec proposal status: Draft → Implemented
- [ ] Add an OwnMind memory project entry "v1.18.0 iron rule SKILL.md standardization"
- [ ] handoff doc (for the next session)

---

## 17. Vin's manual migration (not counted as dev, Vin batches it himself)

- [ ] open admin /iron-rule-upgrade
- [ ] 35 rules × ~1 min = 35 minutes
- [ ] can split across sessions, rules you don't want to convert stay plain text (always graceful)
