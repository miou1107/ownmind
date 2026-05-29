# v1.18.0 — Spec

GIVEN/WHEN/THEN three-part formal spec + design details. Corresponds to proposal.md's acceptance criteria.

---

## 1. SKILL.md iron rule format spec

### 1.1 frontmatter schema

```yaml
---
name: <kebab-case identifier>          # required, 3-60 chars, ^[a-z0-9-]+$
description: <pushy trigger sentence>  # required, 20-500 chars, must contain a trigger word
---
```

Only two fields, aligned to the Anthropic SKILL.md standard, **no custom fields**.

### 1.2 frontmatter detection

GIVEN an iron rule content
WHEN it starts with `---\n` and has a matching `\n---\n` afterward
THEN treat as SKILL.md format, run schema lint

GIVEN an iron rule content
WHEN it doesn't start with `---\n` or no `\n---\n` is found at the end
THEN treat as plain text, run v1.17.94 regex lint (backward compatible)

### 1.3 schema lint (when frontmatter present)

| Rule ID | Check | Failure behavior |
|---|---|---|
| S1 | YAML frontmatter parses validly | reject 400 |
| S2 | `name` required, kebab-case (`/^[a-z0-9-]+$/`) | reject 400 |
| S3 | `name` length 3-60 | reject 400 |
| S4 | `description` required, length 20-500 | reject 400 |
| S5 | `description` contains a trigger word (`/when|whenever|use\s+when|triggers\s+on|何時|觸發|情境|準備|要做/i`) | reject 400 |
| S6 | body (after frontmatter) length ≥ 100 | reject 400 |
| S7 | body contains a rule-section keyword (`/規則|該做|不該做|禁止|必須|應該|不可|不要/`) | reject 400 |
| S8 | mixed CJK-English check (IR-037, reuse v1.17.94) | reject 400 |
| S9 | `description` length < 50 | warning (**not reject**) |

### 1.4 regex lint (when no frontmatter, backward compatible)

GIVEN iron rule content has no frontmatter
WHEN server runs lintIronRule
THEN use v1.17.94 rules #1-#7 entirely unchanged

---

## 2. MCP API spec

### 2.1 `ownmind_save` accepts SKILL.md format

GIVEN MCP client calls `ownmind_save({ type: 'iron_rule', title, content, tags })`
WHEN content is `---\nname: ...\ndescription: ...\n---\n# 標題\n...`
THEN
- server detects frontmatter, runs schema lint
- on pass → write DB (content field stores the full frontmatter + body)
- trigger sync hook (see §4)
- response includes `format: 'skill_md'`

### 2.2 `ownmind_save` plain-text fallback

GIVEN MCP client calls `ownmind_save({ type: 'iron_rule', ..., content })` with no frontmatter
WHEN
THEN
- server uses v1.17.94 regex lint
- on pass → write DB
- trigger sync hook (also syncs, but the reference file holds the plain text directly; sync auto-fills a minimal SKILL.md frontmatter version)
- response includes `format: 'legacy_text'`

### 2.3 `ownmind_update` same as above

GIVEN client edits an iron rule content
WHEN
THEN
- same rules as ownmind_save: detect frontmatter → schema lint or regex lint
- after edit, if a `previous_content` column exists (Decision #4) → back up the pre-edit content into it

---

## 3. Upgrade helper Web UI spec

### 3.1 GET `/api/admin/iron-rules/upgrade-status`

GIVEN admin logged in
WHEN calling this endpoint
THEN response:
```json
{
  "total": 35,
  "skill_md_format": 0,
  "legacy_text": 35,
  "rules": [
    {
      "id": 5,
      "code": "IR-002",
      "title": "不要 commit ...",
      "format": "legacy_text",
      "tags": ["trigger:commit", "trigger:git"]
    },
    ...
  ]
}
```

### 3.2 POST `/api/admin/iron-rules/:id/suggest-skill-md`

GIVEN admin clicks [Suggest SKILL.md format]
WHEN POST `/api/admin/iron-rules/5/suggest-skill-md`
THEN
- server uses an LLM (Claude API, via OWNMIND_SUGGEST_API_KEY env; if absent, disable the button) to derive SKILL.md format from the rule's title + content + tags
- response `{ suggested: '---\nname: ...\n---\n...', warnings: [...] }`
- **does not write DB**

### 3.3 PUT `/api/admin/iron-rules/:id/upgrade`

GIVEN admin reviews the diff in the Web UI and clicks [Confirm & Save]
WHEN PUT `/api/admin/iron-rules/5/upgrade { content: '...' }`
THEN
- server runs schema lint (on fail, reject 400 directly)
- on pass → back up the old content into `previous_content`, write the new content into content
- trigger sync hook
- response `{ ok: true, format: 'skill_md' }`

### 3.4 Web UI behavior spec

GIVEN admin on the `/admin/iron-rule-upgrade` panel
WHEN the list displays
THEN
- list of 35 iron rules, each showing a [Legacy] or [SKILL.md] tag on the right
- sorted by format by default (Legacy on top)
- each has three buttons: [Suggest], [Edit], [Skip]

GIVEN admin clicks [Suggest]
WHEN
THEN
- show the diff view (left original / right proposed)
- provide a [Edit Proposed] textarea for tweaking
- [Confirm & Save] PUTs the current textarea content up

---

## 4. Sync mechanism spec (conditional pull, sync_token hash check)

### 4.0 Why conditional pull

OwnMind already has `sync_token` (`src/utils/syncToken.js`):
- formula: `sha256(user_id : max(memory.updated_at) : max(team.updated_at)).slice(0, 12)`
- any write operation changes `updated_at` → `sync_token` auto-changes
- existing use: MCP client **write** operations must carry sync_token; server rejects on mismatch (guards against stale clients)

v1.18.0 completes the read side: the SessionStart hook uses `sync_token` for an If-None-Match-style conditional pull.

### 4.1 New endpoint: `GET /api/memory/sync-token`

GIVEN client needs to quickly judge whether the local cache is stale
WHEN `GET /api/memory/sync-token` with Authorization Bearer
THEN
- server runs `generateSyncToken(userId)` (existing helper)
- returns `{ "sync_token": "a1a785218482" }` (~50 bytes)
- **does not query any iron rule / memory content** (lightweight)

### 4.2 SessionStart hook conditional sync flow

GIVEN SessionStart hook runs
WHEN
THEN
1. read local cache `~/.ownmind/cache/memories.json`
2. extract `cache.sync_token` and `cache.saved_at`
3. **expiry safety**: if `Date.now() - cache.saved_at > 24hr` → go straight to the full download path
4. otherwise: `GET /api/memory/sync-token`
5. compare:
   - `local === server` → **skip init download**, use local cache, no-op skill files (99% of sessions take this branch)
   - `local !== server` → run full `GET /api/memory/init?compact=true`, write new cache (with new sync_token + saved_at), rewrite `~/.claude/skills/ownmind-iron-rules/`
6. failure fallback: sync-token endpoint fails → go full init (safe); full init fails → run with local cache (offline mode, existing `mcp/offline.js` logic)

### 4.3 Write trigger

GIVEN `ownmind_save` / `ownmind_update` successfully writes an iron rule
WHEN MCP client receives server 200
THEN
- server-side `updated_at` auto-changes → sync_token changes
- **MCP client need not sync proactively** — the next SessionStart compares tokens, finds the change, auto-refreshes
- **optional optimization**: after a successful write, the MCP client rewrites that rule's local reference file directly (immediate effect, no need to wait for the next SessionStart)

### 4.4 cache file format

```json
{
  "sync_token": "a1a785218482",
  "saved_at": "2026-05-13T04:50:17.875Z",
  "data": {
    "iron_rule": [...],
    "profile": [...],
    ...
  }
}
```

Fully consistent with the existing `~/.ownmind/cache/memories.json` format (**no new file, no ALTER needed**) — the SessionStart hook just starts using it.

### 4.5 Reconcile safety

GIVEN local cache `saved_at` older than 24 hr
WHEN SessionStart hook runs
THEN
- force the full download path even if the sync-token comparison matches
- guards against a miscomputed sync_token causing a permanently stale cache
- the 24 hr threshold is a constant in `hooks/lib/sync-iron-rules.js`

### 4.2 Local file structure

```
~/.claude/skills/ownmind-iron-rules/
├── SKILL.md                                    # big skill metadata
└── references/
    ├── IR-001-XXX.md                            # one file per iron rule
    ├── IR-002-no-commit-secrets.md
    ├── IR-003-bug-reproduction-test.md
    └── ... (35 files)
```

### 4.3 SKILL.md (big skill) content

```yaml
---
name: ownmind-iron-rules
description: |
  Use whenever you do ANY action that touches code, commits, deploys, edits, debugs,
  or any work covered by Vin's iron rules. OwnMind has N iron rules covering
  git workflow, deploy safety, secret management, debugging discipline, doc sync,
  and AI work quality. ALWAYS consult this when you're about to commit, deploy,
  delete, edit code, or write any user-facing response.
---

# OwnMind Iron Rules

Vin 的個人鐵律集合 — 從歷史踩坑學來的、必須嚴格遵守的工作規則。

## 觸發索引（按 trigger 分類）

### trigger: edit
- IR-003: 修 bug 前先寫 reproduction test → references/IR-003-bug-reproduction-test.md
- IR-005: 不要 blind edit → references/IR-005-no-blind-edit.md
- ...

### trigger: commit / git
- IR-002: 不要 commit .env 或密碼 → references/IR-002-no-commit-secrets.md
- IR-008: commit 必須同步 README/FILELIST/CHANGELOG → references/IR-008-three-doc-sync.md
- ...

### trigger: deploy
- IR-018: Docker build 要加 --no-cache → references/IR-018-docker-no-cache.md
- IR-023: 部署必須用 docker compose build → references/IR-023-compose-not-docker.md
- ...

(N 個 trigger 分類)

## 如何使用

當你要做某個 trigger 對應的動作時、查上方索引找到相關鐵律、讀 references/ 對應檔案
拿到完整 do/dont 細節。
```

### 4.4 references/IR-XXX.md content

Each reference file is that rule's complete SKILL.md format:

```yaml
---
name: ir-002-no-commit-secrets
description: |
  Use when about to git commit / push any change. Required for ALL commits...
---

# IR-002: 不要 commit .env 或密碼

(full body)
```

Or for a legacy rule, plain text directly + auto-filled minimal frontmatter:

```yaml
---
name: ir-011-timezone-standard
description: |
  IR-011: 時區強制定標準
  Triggers on: edit. (auto-generated from legacy text rule)
---

(original content, plain text)
```

### 4.5 Conflict handling

GIVEN local `references/IR-002-no-commit-secrets.md` is hand-edited by the user
WHEN the sync hook detects local content differs from the DB
THEN
- DB always wins, overwrites local (Decision #6)
- log a warning to `~/.ownmind/logs/sync-conflicts.jsonl` recording the overwritten content
- **does not interrupt sync**

### 4.6 Cross-AI-tool sync (reuse install.sh:300 pattern)

GIVEN an iron rule write triggers sync
WHEN the sync hook runs
THEN for the following tools, write only if the directory exists:

| Tool | How |
|---|---|
| Claude Code | `~/.claude/skills/ownmind-iron-rules/` full skill folder (main path) |
| Cursor | `~/.cursor/rules/ownmind-iron-rules.md` inlines SKILL.md + 35 references into a single file |
| Antigravity | `~/.antigravity/rules/ownmind-iron-rules.md` same as Cursor |
| OpenCode | `~/.opencode/AGENTS.md` add a `<!-- ownmind-iron-rules -->` block containing the skill summary |
| Codex | `~/.codex/AGENTS.md` same as OpenCode |
| Windsurf | `~/.windsurf/rules/ownmind-iron-rules.md` same as Cursor |
| Gemini | `~/.gemini/GEMINI.md` same as OpenCode |

If Decision #5 chooses the reduced scope, only implement Claude Code + Codex / Gemini AGENTS.md style.

---

## 5. DB schema direction

### 5.1 Don't touch `memories.content`

content stays a TEXT column; SKILL.md frontmatter + body fits in too, no ALTER needed.

### 5.2 Add a `previous_content` backup column (if Decision #4 = yes)

```sql
-- db/013_iron_rule_previous_content.sql
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS previous_content TEXT;
```

### 5.3 `format` column (optional, not necessarily needed)

Add `format VARCHAR(20)` to record 'skill_md' / 'legacy_text'?
**Not done in v1.18.0** — detect frontmatter from content directly, avoiding a DB-vs-content double-write inconsistency.

---

## 6. Lint behavior overview

```
client write iron_rule
    ↓
server: lintIronRule(content)
    ↓
detect frontmatter?
  ├─ yes → schema lint (S1-S9) → pass/reject
  └─ no  → v1.17.94 regex lint (#1-#7) → pass/reject
        ↓
       pass → write DB → trigger sync hook
            ↓
           sync writes local + cross-tool
```

---

## 7. Test spec

### 7.1 schema lint tests

- frontmatter parse failure → reject
- name missing / too short / too long / not kebab-case → reject
- description missing / too short / too long / no trigger word → reject
- body too short / no rule keyword → reject
- description length < 50 → warning (not reject)
- complete valid SKILL.md → pass

### 7.2 regex lint backward-compat tests

- each of the existing 35 iron rules that passed v1.17.94 lint should not be rejected by the new version (regression test)
- a plain-text iron rule that writes fine → schema lint should not be triggered

### 7.3 Sync tests

- write iron rule → local reference file auto-created
- edit iron rule → local reference file auto-updated
- disable iron rule → local reference file auto-deleted
- SessionStart runs, local vs DB differs → reconcile update
- local hand-edit → DB wins, overwrites + log warning

### 7.3b Conditional sync tests (important)

- `GET /api/memory/sync-token` returns a 12-char hex sync_token, < 100 bytes
- SessionStart: local cache token === server token → **don't hit init endpoint** (verify with mock server)
- SessionStart: local cache token !== server token → hit init + rewrite cache + rewrite skill files
- SessionStart: local cache `saved_at` > 24hr → force init path even if token matches
- SessionStart: sync-token endpoint fails → fallback to full init
- SessionStart: full init fails → fallback to local cache (existing `mcp/offline.js` logic)
- write iron rule → next SessionStart should detect the sync_token change

### 7.4 Upgrade helper tests

- GET upgrade-status → returns status of 35 rules
- POST suggest-skill-md → returns a SKILL.md proposal (mock LLM)
- PUT upgrade (valid SKILL.md) → pass lint + write DB + back up previous_content + trigger sync
- PUT upgrade (invalid) → reject 400 + don't touch DB

### 7.5 Cross-tool sync tests

- Cursor directory exists → write ownmind-iron-rules.md
- Cursor directory missing → skip
- Codex `AGENTS.md` exists → add a new block, preserve existing content
- Codex `AGENTS.md` missing → don't write (avoid polluting uninstalled tools)
