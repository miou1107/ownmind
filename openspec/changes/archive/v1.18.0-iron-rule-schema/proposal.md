# v1.18.0 — Align iron rules to SKILL.md + ship 1 big iron-rules skill, landing IR-027

- **Author**: Vin
- **Date**: 2026-05-13
- **Status**: Draft (v3 — decided on plan B: 1 big skill; awaiting decisions on remaining 6 items)
- **Worktree**: `determined-bouman-20c22a`
- **Branch**: `vin/determined-bouman-20c22a`

---

## 0. Design evolution (v1 → v2 → v3 → v4)

| Version | Core | Why it evolved |
|---|---|---|
| v1 | Custom 7-field schema (do / dont / triggers / ...) | Vin noted "should reference the skills standard and skill-creator approach" — the custom schema was wrong |
| v2 | Align to Anthropic SKILL.md standard (name + description + body) + DB-only | Vin asked "faster, lighter, more precise enforcement?" — pure DB does not solve the IR-027 enforcement essence |
| v3 | Same as v2 + export into 1 `~/.claude/skills/ownmind-iron-rules/SKILL.md` big skill | Vin noted "OwnMind already has the ownmind-memory big skill, 35 individual ones is too messy" — go with plan B |
| **v4** | **Same as v3** + **conditional sync (existing sync_token hash check, 99% of sessions skip download)** | Vin noted "should use a hash check, sync only when needed" — the existing sync_token mechanism was only used on the write side, never the read side; now completed |

---

## 1. Why make this change

### 1.1 v1.17.94 lint gates on "keyword heuristics", not real structure

Current 7 checks (word count / trigger:xxx tag / keyword regex for "適用" "規則" / mixed CJK-English / forbidden context words) — AI just needs to stuff in a "適用" to pass.

### 1.2 IR-027 "reminders don't work, only logic does" is not 80%+ landed

| State | AI enforcement landing |
|---|---|
| Current (SessionStart injects a list of 35 titles) | **50%** (whether to comply is the AI's own call) |
| v1.18.0 pure schema alignment (DB-only) | 60-65% (a slightly stronger pushy description, but essentially still AI self-awareness) |
| v1.18.0 + 1 big iron-rules skill (**this version**) | **70%** (triggered by the Claude Code skill mechanism; once in the skill the AI picks which iron rule applies) |

### 1.3 Not portable across AI tools

Currently iron rules are only visible to Claude Code via the OwnMind hook; Cursor / Codex / Antigravity cannot see them. After aligning to the SKILL.md standard and exporting to files, they are consistent across AI tools.

---

## 2. Design core

### 2.1 The iron rule itself aligns to the SKILL.md standard

Each iron rule's content becomes SKILL.md frontmatter + body:

```yaml
---
name: ir-002-no-commit-secrets
description: |
  Use when about to git commit / push any change. Required for ALL commits because
  accidentally pushing .env / API keys / passwords to GitHub causes immediate exposure
  and rotation requirements. Triggers on: git commit, git push, git stash, any change
  staged for commit. ALSO triggers when user mentions "commit", "push", "deploy".
---

# IR-002: 不要 commit .env 或密碼

## 為什麼存在
(story)

## 該做 / 不該做 / 萬一犯了
(free markdown paragraphs, no forced YAML list structure)
```

**The SKILL.md standard has only 2 required fields** (name + description) — no custom fields.

### 2.2 Export into 1 big iron-rules skill (plan B)

Same pattern as OwnMind's existing `ownmind-memory`:

```
~/.claude/skills/ownmind-iron-rules/
├── SKILL.md                      # big skill metadata + trigger summary of 35 iron rules
├── references/
│   ├── IR-002-no-commit-secrets.md    # AI reads only when it wants details (progressive disclosure layer 3)
│   ├── IR-003-bug-reproduction-test.md
│   ├── IR-008-three-doc-sync.md
│   └── ... (35 reference files, each the full SKILL.md frontmatter + body of that rule)
└── scripts/                      # optional, future home for iron-rule automation scripts
    └── (not done in v1.18.0, left as backlog)
```

### 2.3 Why choose B (1 big skill) over C (35 individual skills)

| Comparison | A current | B (this version) | C (35) |
|---|---|---|---|
| Extra entries in Claude Code skill list | 0 | +1 | +35 (would overflow) |
| Always in-context tokens | ~400 | ~150 | ~3500 |
| AI trigger precision | 50% | 70% | 80-90% |
| Consistent with existing ownmind-memory | — | ✓ | ✗ |
| Sync complexity | 0 | low | high |
| Vin's deciding reason | — | **"same pattern as ownmind-memory, not messy"** | "35 is too messy" |

**B is a superset of C; upgrading to C later is not blocked** (reference files are already in individual format; just change sync to write an individual skill folder).

### 2.4 Graceful dual track, never force migration

| Path | Behavior |
|---|---|
| New iron rule write | client uses SKILL.md frontmatter + body format, server gates on required name + description |
| Existing 35 iron rules | **no auto-conversion**, plain-text format supported long-term, Vin converts manually via the upgrade helper |
| Server lint | detect frontmatter: present → schema lint; absent → fall back to old v1.17.94 regex |
| Old client writes iron rule | server uses graceful fallback, will not reject |
| SessionStart context | unchanged (title + tags, one per line) |
| `~/.claude/skills/ownmind-iron-rules/` | new — maintained by the sync hook |
| Sync mechanism | push to local on write + reconcile during SessionStart (B+A double safety) |

---

## 3. lint rules

Align to the SKILL.md standard + iron-rule-specific reinforcements:

| Check | Source | Reject / Warning |
|---|---|---|
| frontmatter parses as valid YAML | SKILL.md standard | reject |
| `name` required, kebab-case, 3–60 chars | SKILL.md standard (iron rule adds length limit) | reject |
| `description` required, 20–500 chars | SKILL.md standard | reject |
| `description` contains a trigger word like 「when / 何時 / 觸發 / 情境」 | iron-rule-specific | reject |
| body word count ≥ 100 | iron-rule-specific | reject |
| body contains a keyword like 「該做 / 不該做 / 規則 / 必須」 | reuse v1.17.94 #5 | reject |
| mixed CJK-English check (IR-037) | reuse v1.17.94 | reject |
| `description` word count < 50 | iron-rule-specific (encourage pushy writing) | **warning (not reject)** |

**Avoid going back down the old "custom fields + forced list structure" path**. description is free-text with light keyword checks, body is free-form markdown — fully consistent with the Anthropic SKILL.md spec.

---

## 4. Sync mechanism design

### 4.1 DB ↔ local file sync (conditional pull, relies on existing sync_token)

**The source of truth is always the DB** (kkvin.com Postgres). Local `~/.claude/skills/ownmind-iron-rules/` is a read-only mirror.

**Key design**: use OwnMind's existing `sync_token` (`src/utils/syncToken.js`) for a hash check, so 99% of sessions skip the download.

```
sync_token = sha256(user_id : max(memory.updated_at) : max(team.updated_at)).slice(0, 12)
```

| Trigger point | Behavior |
|---|---|
| `ownmind_save` / `ownmind_update` writes an iron rule | server `updated_at` auto-changes → sync_token auto-changes, no special handling needed |
| Start of SessionStart hook | **new flow**: 1. read local cache `sync_token` → 2. `GET /api/memory/sync-token` (lightweight, ~50 bytes) → 3. compare: same → use local cache, skip download; different → run a full init download + rewrite cache + rewrite local skill files |
| Iron rule disabled | server updated_at changes → next SessionStart detects the sync_token change → auto refresh |
| 24hr no-reconcile safety | local cache `saved_at` older than 24 hr → force refresh, guards against a miscomputed sync_token caching forever |
| User edits iron rule, source conflict (DB vs local) | DB wins, local is overwritten (Vin chose option A) |

### 4.2 Multi-machine sync

```
Your Mac edits IR-040 → DB
                ↓ MCP client sync
              Mac local file ✓ immediate
              office computer local file ❓ syncs at next SessionStart reconcile
```

= last-write-wins; sync is a passive pull, not an active cross-machine push (OwnMind has no push notification mechanism). **v1.18.0 does not solve real-time multi-machine sync**, left as backlog.

### 4.3 Cross-user

- Iron rules are per-user (`memories.user_id` isolated)
- Local path `~/.claude/skills/ownmind-iron-rules/` is naturally per-user isolated
- Vin / Bob / Alice each sync their own iron rules, without interfering

### 4.4 Cross-AI-tool paths

| Tool | Skill path | v1.18.0 handling |
|---|---|---|
| Claude Code | `~/.claude/skills/` | ✓ main path |
| Cursor | `~/.cursor/rules/` | sync writes a copy too (IR-006 full-layer-sync spirit) |
| Codex | `~/.codex/AGENTS.md` | add a reference section pointing to ownmind-iron-rules (not a standalone skill) |
| Antigravity | `~/.antigravity/rules/` | same as Cursor |
| OpenCode | `~/.opencode/AGENTS.md` | same as Codex |
| Windsurf | `~/.windsurf/rules/` | same as Cursor |
| Gemini | `~/.gemini/GEMINI.md` | same as Codex |

**install.sh / update.sh's existing "append_upgrade_rule_if_exists" pattern can be reused** (see install.sh:300) — install only if the directory is detected, skip if not present.

---

## 5. Iron rule upgrade helper (Web UI)

Lets Vin convert the existing 35 iron rules to SKILL.md format manually + AI-assisted.

### 5.1 Admin panel: `/admin/iron-rule-upgrade`

```
┌─ Iron Rule Upgrade Helper ────────────────────────┐
│                                                    │
│ Status: 35 total / 0 SKILL.md / 35 legacy        │
│                                                    │
│ ┌─ IR-002: 不要 commit .env 或密碼 ─ [Legacy] ┐  │
│ │  Title:   不要 commit .env 或密碼               │  │
│ │  Tags:    [trigger:commit, trigger:git]         │  │
│ │  [Suggest SKILL.md format]                       │  │
│ └─────────────────────────────────────────────────┘  │
│                                                    │
│ (other 34 rules...)                              │
└────────────────────────────────────────────────────┘
```

### 5.2 After clicking [Suggest]

```
┌─ AI Suggestion for IR-002 ────────────────────────┐
│ ┌─ Diff View ────────────────────────────────────┐ │
│ │ - Original (純文字)                             │ │
│ │ + Proposed (SKILL.md frontmatter + body)        │ │
│ │                                                  │ │
│ │ + ---                                            │ │
│ │ + name: ir-002-no-commit-secrets                │ │
│ │ + description: |                                 │ │
│ │ +   Use when about to git commit / push...      │ │
│ │ + ---                                            │ │
│ │ + # IR-002: 不要 commit .env 或密碼              │ │
│ │ + ## 為什麼存在 (從原 content 提取)              │ │
│ │ + ## 該做 / 不該做                                │ │
│ └──────────────────────────────────────────────────┘ │
│                                                    │
│ [Edit Proposed]  [Confirm & Save]  [Skip]         │
└────────────────────────────────────────────────────┘
```

### 5.3 Flow

1. Click [Suggest] → server uses an LLM to derive SKILL.md from title + content + tags
2. Vin reviews the diff → [Edit] tweak / [Skip] keep plain text / [Confirm] write to DB
3. After [Confirm], server runs schema lint; on pass → write DB + trigger sync
4. Rules you don't want to convert stay plain text forever, graceful dual track

Estimate: 35 rules × ~1 minute ≈ 35 minutes, can be split across sessions.

---

## 6. What's out of scope (explicitly excluded)

- ❌ Custom schema fields (v1's mistake)
- ❌ 35 individual skills (plan C, excluded by Vin's decision)
- ❌ Forced migration script
- ❌ Lazy migration (auto-conversion)
- ❌ Changing SessionStart context to load the body (avoid token bloat)
- ❌ Changing DB schema to split out fields (content stays TEXT)
- ❌ Forcing all new iron rules to use SKILL.md
- ❌ Bundled scripts per iron rule (v1.18.0 reserves a scripts/ dir but ships no script; actual scripting left to v1.18.x)
- ❌ Real-time multi-machine sync (SessionStart reconcile is enough)
- ❌ DB vs local conflict-detection mechanism (DB always wins, no choice UI)

---

## 7. Risks

| Risk | Probability | Consequence | Mitigation |
|---|---|---|---|
| YAML frontmatter parser written too loosely | medium | lint accepts content it shouldn't | use the `js-yaml` package (industry standard), don't write your own parser |
| `js-yaml` adds a new npm dep | low | server bundle ~50KB | accept, no security concern |
| Upgrade helper LLM suggests a wrong description | medium | iron rule written imprecisely, AI can't see the trigger | Vin must review the diff view, save only after confirming |
| Plain-text iron rule from an old client triggers the new lint warning | low | UX annoyance | add an env to suppress the warning |
| Upgrade helper corrupts the DB | medium | iron rule content damaged | back up the original value to `memories.previous_content` JSONB before writing (small ALTER) |
| Sync hook bug corrupts local skill files | medium | Claude Code skill fails to load | on sync failure, fallback leaves local untouched, logs a warning; DB is always the source of truth |
| Cross-tool path written wrong / forced write to an uninstalled tool | low | writing to a nonexistent / incorrect directory | reuse install.sh:300's existing "install only if directory exists" pattern |
| Too-short/too-vague description passes lint (warning, no block) | medium | AI can't recall the iron rule | warning + the upgrade helper proactively suggests reinforcement |

---

## 8. Acceptance criteria (high level)

- [ ] **New iron rules use SKILL.md** — `ownmind_save` accepts frontmatter + body, server lint gates on required name + description, presence of a trigger word, body containing a rule section
- [ ] **Old iron rules keep working** — existing 35 take 0 actions, SessionStart loads fine, `ownmind_get` retrieves fine
- [ ] **Old client writing an iron rule doesn't break** — graceful fallback, uses regex lint
- [ ] **Iron rule upgrade helper** — admin web UI panel, lists 35 rules with status, select one to open the diff view, save after confirm
- [ ] **Local sync** — `~/.claude/skills/ownmind-iron-rules/SKILL.md` + reference files auto created/updated, Vin sees them immediately after writing an iron rule, SessionStart reconciles
- [ ] **Cross AI tools** — Cursor / Antigravity / OpenCode / Codex / Gemini / Windsurf, all installed tools receive the iron rule sync (reuse install.sh:300 pattern)
- [ ] **Three-doc sync** (IR-008) — README / CHANGELOG / FILELIST
- [ ] **OpenSpec spec.md** — full SKILL.md schema definition + sync mechanism + lint rules GIVEN/WHEN/THEN
- [ ] **Regression**: v1.17.99's full 1054 tests + new schema lint tests + parser tests + sync tests + upgrade-helper tests, totaling ≥ 1100, all green

---

## 9. Effort estimate

| Phase | Content | Estimate |
|---|---|---|
| Spec | spec.md GIVEN/WHEN/THEN | 30 min |
| Tasks | tasks.md breakdown | 15 min |
| Backend: parser + schema lint + MCP API | js-yaml + lintIronRule v2 + ownmind_save schema acceptance | 2-3 hr |
| Backend: new endpoint `GET /api/memory/sync-token` + sync hook + cross-tool path writes | conditional pull + trigger sync after DB iron-rule write | 2.5-3.5 hr (+0.5 hr) |
| Web UI upgrade helper | admin panel + diff view + LLM suggest + confirm flow | 2-3 hr |
| Migration (Vin converts the 35 himself) | manual conversion via the upgrade helper | 35 min × N times |
| Test | schema lint + parser + sync flow + conditional pull + UI flow | 2.5 hr (+0.5 hr) |
| Code review + receiving | quality-control three steps | 1 hr |
| Deploy + browser test | IR-018 / 020 / 023 | 30 min |
| **Total (excluding Vin's manual conversion of old rules)** | | **11-14 hours** (+1 hr for adding conditional sync) |

Can be split into 3 commits:
- v1.18.0-rc1: parser + schema lint + MCP API (backend, ~3 hr)
- v1.18.0-rc2: sync hook + cross-tool paths (~3 hr)
- v1.18.0-rc3: upgrade-helper web UI + integration (~3 hr)
- v1.18.0: docs + tag + deploy

---

## 10. Remaining 6 decisions awaiting Vin

1. **Migration strategy**: manual + AI-assisted in batches (via the Web UI upgrade helper) ✓ — default this, change?
2. **lint description pushiness**: < 50 chars warning (not reject), ≥ 20 chars required to save — OK?
3. **Introduce `js-yaml`**: 50KB bundle add, industry standard — agree?
4. **Add a `previous_content` backup column to the DB**: recoverable if the upgrade helper corrupts data — want it? (if not, no backup of the original value before editing a rule)
5. **Cross-tool sync scope**: write to all of Cursor / Codex / Antigravity / OpenCode / Windsurf / Gemini? Or only Claude Code (`~/.claude/skills/`) + Codex (`~/.codex/AGENTS.md`)?
6. **Sync conflict handling**: DB always wins (overwrites local) — accept? (alternative: detect conflict → prompt Vin to choose manually, high complexity)
